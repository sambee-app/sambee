import { describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { subscribeMissingPhysicalFiles } from "../../services/fileRecoveryEvents";
import { PreviewUnavailableError } from "../../services/previewPolicy";
import { createStorageBackedTestContentProviderRegistry } from "../../test/helpers";
import { requireTestValue } from "../../test/helpers/assertions";
import { createMockLocalArchiveExecution } from "../../test/helpers/mockFactories";
import { FileType } from "../../types";
import { getArchiveExtractionAvailability, startArchiveExtraction } from "./contentOperations";
import {
  beginViewerTextEdit,
  createStorageBackedContentProviderRegistry,
  invalidateViewerPdfDerivative,
  physicalItem,
  physicalLocation,
  readContent,
  readViewerContent,
  readVirtualContent,
  verifyViewerSourceAfterFailure,
  virtualItem,
  virtualItemHandle,
  virtualLocation,
} from "./contentProviders";

vi.mock("../../services/api", () => ({
  default: {
    getArchiveMember: vi.fn(),
    getFileBlob: vi.fn(),
    getOriginalFileBlob: vi.fn(),
    getImageBlob: vi.fn(),
    invalidateArchiveMemberPdfDerivative: vi.fn(),
    invalidatePdfDerivative: vi.fn(),
    startLocalArchiveExtraction: vi.fn(),
    getLocalArchiveExtraction: vi.fn(),
    cancelLocalArchiveExtraction: vi.fn(),
    waitForLocalArchiveExecution: vi.fn(),
    decideLocalArchiveExecution: vi.fn(),
    cancelLocalArchiveExecutionWithRevisionRetry: vi.fn(),
    extractLocalArchiveToSmb: vi.fn(),
    decideLocalArchiveRelayExtraction: vi.fn(),
    getLocalArchiveRelayExtractionStatus: vi.fn(),
    extractSmbArchiveToLocal: vi.fn(),
    prepareArchiveOperation: vi.fn(),
    getArchiveCompanionSession: vi.fn(),
    executeArchiveExtraction: vi.fn(),
    getArchiveLiveExtractionStatus: vi.fn(),
    decideArchiveExtraction: vi.fn(),
    cancelArchiveOperation: vi.fn(),
    getPdfBlob: vi.fn(),
    listArchiveDirectory: vi.fn(),
    listDirectory: vi.fn(),
    saveTextFile: vi.fn(),
  },
}));

function localArchiveProgress(completedMembers = 0, skippedMembers = 0, totalMembers?: number, totalBytes?: number) {
  return { completedMembers, skippedMembers, failedMembers: 0, totalMembers, totalBytes };
}

function extractionAggregate(filesExtracted = 0, directoriesCreated = 0, extractedBytes = 0, membersSkipped = 0, filesReplaced = 0) {
  const membersCompleted = filesExtracted + directoriesCreated;
  return {
    members_processed: membersCompleted + membersSkipped,
    members_completed: membersCompleted,
    members_skipped: membersSkipped,
    members_failed: 0,
    files_extracted: filesExtracted,
    directories_created: directoriesCreated,
    extracted_bytes: extractedBytes,
    files_replaced: filesReplaced,
  };
}

function archiveConflict(sourcePath: string, targetPath: string, isDirectory = false) {
  return {
    source: { path: sourcePath, size: 5, modifiedAt: "2025-01-01T12:00:00Z" },
    target: { path: targetPath, size: 10, modifiedAt: "2025-01-02T12:00:00Z" },
    isDirectory,
  };
}

function liveCollision(memberPath: string, targetPath: string, revision = 1) {
  return {
    revision,
    kind: "collision" as const,
    member_path: memberPath,
    delivery_sequence: revision,
    is_directory: false,
    allowed_actions: ["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"],
    source: { path: memberPath, size: 5, modified_at: "2025-01-01T12:00:00Z" },
    target: { path: targetPath, size: 10, modified_at: "2025-01-02T12:00:00Z" },
  };
}

function liveExtractionStatus(pendingDecision: Record<string, unknown>) {
  return {
    source_session_id: "source-session-1",
    phase: "awaiting_decision",
    aggregate_counters: {
      members_processed: 0,
      members_completed: 0,
      members_skipped: 0,
      members_failed: 0,
      files_extracted: 0,
      directories_created: 0,
      extracted_bytes: 0,
      files_replaced: 0,
    },
    pending_decision: pendingDecision,
  };
}

describe("content providers", () => {
  it.each([true, false])("checks an ambiguous media failure without publishing a stale absence (current=%s)", async (current) => {
    const providers = createStorageBackedTestContentProviderRegistry();
    const provider = providers.get(physicalLocation("conn-1", "docs"));
    provider.getInfo = vi
      .fn()
      .mockRejectedValue({ response: { status: 404, data: { detail: { code: "item_not_found", message: "private source path" } } } });
    let active = true;
    provider.getInfo = vi.fn().mockImplementation(async () => {
      active = current;
      throw { response: { status: 404, data: { code: "item_not_found" } } };
    });
    const missing = vi.fn();
    const unsubscribe = subscribeMissingPhysicalFiles(missing);
    try {
      const message = await verifyViewerSourceAfterFailure("conn-1", "docs/image.png", undefined, providers, () => active);
      expect(provider.getInfo).toHaveBeenCalledTimes(1);
      expect(message).toBe(current ? 'File "image.png" was not found. It may have been moved or deleted.' : null);
      expect(missing).toHaveBeenCalledTimes(current ? 1 : 0);
      if (current) expect(missing).toHaveBeenCalledWith({ connectionId: "conn-1", path: "docs/image.png" });
    } finally {
      unsubscribe();
    }
  });

  it("does not report absence when metadata confirms the image still exists", async () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    providers.get(physicalLocation("conn-1", "docs")).getInfo = vi.fn().mockResolvedValue({ type: FileType.FILE });
    const missing = vi.fn();
    const unsubscribe = subscribeMissingPhysicalFiles(missing);
    try {
      expect(await verifyViewerSourceAfterFailure("conn-1", "docs/image.png", undefined, providers, () => true)).toBeNull();
      expect(missing).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  const archiveLocation = virtualLocation("zip", "conn-1", physicalLocation("conn-1", "archives/one.zip"), "images");

  it("gives physical and virtual locations distinct capability profiles", () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    expect(providers.getCapabilities(physicalLocation("conn-1", "photos")).mutate).toBe(true);
    expect(providers.getCapabilities(archiveLocation)).toMatchObject({
      browse: true,
      read: true,
      download: true,
      extract: true,
      mutate: false,
      openInNativeApp: false,
    });
  });

  it("selects ZIP providers by source filename and lists normalized virtual entries", async () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    vi.mocked(api.listArchiveDirectory).mockResolvedValueOnce({
      archive: { path: "archives/one.zip", size: 1 },
      path: "images",
      items: [{ name: "blocked.png", path: "images/blocked.png", type: FileType.FILE, state: "blocked", is_hidden: false }],

      page_size: 100,
    });

    expect(providers.getVirtualProviderIdForFilename("one.zip")).toBe("zip");
    expect(providers.getVirtualProviderIdForFilename("one.img")).toBeNull();

    const listing = await providers.get(archiveLocation).list(archiveLocation, { pageSize: 100 });

    expect(api.listArchiveDirectory).toHaveBeenCalledWith("conn-1", "archives/one.zip", "images", {
      cursor: undefined,
      pageSize: 100,
      signal: undefined,
    });
    expect(listing.items[0]).toMatchObject({
      entry: { path: "images/blocked.png", is_readable: false, archive_entry_state: "blocked" },
      handle: { kind: "virtual", path: "images/blocked.png" },
    });
  });

  it("keeps readable archive directories enabled for navigation", async () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    vi.mocked(api.listArchiveDirectory).mockResolvedValueOnce({
      archive: { path: "archives/one.zip", size: 1 },
      path: "images",
      items: [{ name: "nested", path: "images/nested", type: FileType.DIRECTORY, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const listing = await providers.get(archiveLocation).list(archiveLocation, { pageSize: 100 });

    expect(listing.items[0]).toMatchObject({
      entry: { path: "images/nested", type: FileType.DIRECTORY, is_readable: true, archive_entry_state: "readable" },
    });
  });

  it("preserves the next cursor from storage-backed ZIP listings", async () => {
    const listDirectory = vi.fn().mockResolvedValue({
      archive: { path: "archives/one.zip", size: 1 },
      path: "images",
      items: [],
      total: 2,
      next_cursor: "page-2",
    });
    const resolvedTarget = { target: { kind: "smb", connectionId: "conn-1" } };
    const registry = {
      resolveItem: vi.fn(() => ({ ...resolvedTarget, path: "archives/one.zip", resolvedTarget })),
      getBackend: vi.fn(() => ({ archive: { listDirectory } })),
    };

    const listing = await createStorageBackedContentProviderRegistry(registry as never)
      .get(archiveLocation)
      .list(archiveLocation, { cursor: "page-1" });

    expect(listing.nextCursor).toBe("page-2");
    expect(listDirectory).toHaveBeenCalledWith(expect.anything(), "images", { cursor: "page-1" });
  });

  it("lists an unresolved local drive through the catalog-refresh compatibility path", async () => {
    const location = physicalLocation("local-drive:c", "docs");
    const registry = {
      resolveDirectory: vi.fn(() => {
        throw new Error("Local drive c is unavailable");
      }),
    };
    vi.mocked(api.listDirectory).mockResolvedValueOnce({
      path: "docs",
      items: [{ name: "readme.md", path: "docs/readme.md", type: FileType.FILE, is_readable: true, is_hidden: false }],
      total: 1,
    });

    const listing = await createStorageBackedContentProviderRegistry(registry as never)
      .get(location)
      .list(location);

    expect(api.listDirectory).toHaveBeenCalledWith("local-drive:c", "docs", { signal: undefined });
    expect(listing.items).toEqual([
      physicalItem(location, { name: "readme.md", path: "docs/readme.md", type: FileType.FILE, is_readable: true, is_hidden: false }),
    ]);
  });

  it("does not use the local-drive compatibility path when SMB directory resolution fails", async () => {
    const location = physicalLocation("conn-1", "docs");
    const resolutionError = new Error("Storage connection conn-1 is unavailable");
    const registry = {
      resolveDirectory: vi.fn(() => {
        throw resolutionError;
      }),
    };

    await expect(
      createStorageBackedContentProviderRegistry(registry as never)
        .get(location)
        .list(location)
    ).rejects.toBe(resolutionError);

    expect(api.listDirectory).not.toHaveBeenCalled();
  });

  it("uses source identity in virtual item keys", () => {
    const entry = {
      name: "same.png",
      path: "images/same.png",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    const otherArchiveLocation = virtualLocation("zip", "conn-1", physicalLocation("conn-1", "archives/two.zip"), "images");

    expect(virtualItem(archiveLocation, entry).key).not.toBe(virtualItem(otherArchiveLocation, entry).key);
  });

  it("reads a virtual item through its provider rather than a physical path", async () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    const blob = new Blob(["image"]);
    vi.mocked(api.getArchiveMember).mockResolvedValueOnce(blob);

    await expect(
      readContent(virtualItemHandle(archiveLocation, "images/photo.png"), { kind: "image", viewportWidth: 800 }, undefined, providers)
    ).resolves.toBe(blob);
    expect(api.getArchiveMember).toHaveBeenCalledWith("conn-1", "archives/one.zip", "images/photo.png", {
      download: undefined,
      request: { kind: "image", viewportWidth: 800 },
      signal: undefined,
    });
  });

  it("rejects transformation-dependent local preview reads before fallback transport", async () => {
    vi.clearAllMocks();
    const providers = createStorageBackedTestContentProviderRegistry();
    const localArchiveLocation = virtualLocation(
      "zip",
      "local-drive:c",
      physicalLocation("local-drive:c", "archives/photos.zip"),
      "images"
    );

    await expect(
      readContent(
        { kind: "physical", location: physicalLocation("local-drive:c", "photos"), path: "photos/photo.jxl" },
        { kind: "image" },
        undefined,
        providers
      )
    ).rejects.toBeInstanceOf(PreviewUnavailableError);
    await expect(
      readContent(virtualItemHandle(localArchiveLocation, "images/photo.jxl"), { kind: "image" }, undefined, providers)
    ).rejects.toBeInstanceOf(PreviewUnavailableError);
    expect(api.getImageBlob).not.toHaveBeenCalled();
    expect(api.getArchiveMember).not.toHaveBeenCalled();
  });

  it("extracts a local ZIP through its content provider", async () => {
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    vi.mocked(api.startLocalArchiveExtraction).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 1,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );
    vi.mocked(api.waitForLocalArchiveExecution).mockImplementationOnce(
      requireTestValue(async (_connectionId, _executionId, onUpdate) => {
        onUpdate?.(
          createMockLocalArchiveExecution({
            execution_id: "local-extract-1",
            phase: "streaming",
            revision: 1,
            progress: localArchiveProgress(2, 0, 3, 10),
            cancellation_requested: false,
            aggregate_counters: extractionAggregate(1, 1, 5),
          })
        );
        const completed = createMockLocalArchiveExecution({
          execution_id: "local-extract-1",
          phase: "completed" as const,
          revision: 2,
          progress: localArchiveProgress(3, 1, 3, 10),
          cancellation_requested: false,
          aggregate_counters: extractionAggregate(2, 1, 10, 1),
        });
        onUpdate?.(completed);
        return completed;
      })
    );

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: localArchiveLocation,
      destination: physicalLocation("local-drive:c", "archives/one"),
    });
    const onProgress = vi.fn();
    execution.onProgress(onProgress);

    await expect(execution.result).resolves.toEqual({
      status: "completed",
      filesSkipped: 1,
      summary: {
        filesExtracted: 2,
        directoriesCreated: 1,
        extractedBytes: 10,
        membersProcessed: 4,
        filesSkipped: 1,
        filesReplaced: 0,
        partialMembers: 0,
      },
    });

    expect(api.startLocalArchiveExtraction).toHaveBeenCalledWith("local-drive:c", "archives/one.zip", "archives/one");
    expect(api.waitForLocalArchiveExecution).toHaveBeenCalledWith("local-drive:c", "local-extract-1", expect.any(Function));
    expect(onProgress).toHaveBeenCalledWith({
      filesExtracted: 1,
      directoriesCreated: 1,
      extractedBytes: 5,
      membersProcessed: 2,
      filesSkipped: 0,
      filesReplaced: 0,
      partialMembers: 0,
    });
  });

  it("extracts a local ZIP to a different local drive through the Companion", async () => {
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    vi.mocked(api.startLocalArchiveExtraction).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "cross-drive-extract-1",
        phase: "streaming",
        revision: 1,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );
    vi.mocked(api.waitForLocalArchiveExecution).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "cross-drive-extract-1",
        phase: "completed",
        revision: 2,
        progress: localArchiveProgress(1, 3, 4, 5),
        cancellation_requested: false,
        aggregate_counters: {
          ...extractionAggregate(1, 0, 5, 3),
          encrypted_members_skipped: 1,
          unsupported_compression_members_skipped: 2,
        },
      })
    );

    await expect(
      startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
        source: localArchiveLocation,
        destination: physicalLocation("local-drive:d", "output"),
      }).result
    ).resolves.toMatchObject({
      status: "completed",
      summary: { filesSkipped: 3, encryptedMembersSkipped: 1, unsupportedCompressionMembersSkipped: 2 },
    });

    expect(api.startLocalArchiveExtraction).toHaveBeenCalledWith("local-drive:c", "archives/one.zip", "output", undefined, "local-drive:d");
  });

  it("starts archive extraction through the provider-neutral operation coordinator", async () => {
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-1" } as never);
    vi.mocked(api.executeArchiveExtraction).mockResolvedValueOnce({
      phase: "completed",
      checkpoint_json: JSON.stringify({}),
    } as never);
    const destination = physicalLocation("conn-1", "archives/one");

    expect(getArchiveExtractionAvailability(createStorageBackedTestContentProviderRegistry(), archiveLocation, destination)).toEqual({
      available: true,
    });
    await expect(
      startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
        source: archiveLocation,
        destination,
      }).result
    ).resolves.toMatchObject({ status: "completed" });
    vi.clearAllMocks();
  });

  it("persists selected ZIP member roots before starting extraction", async () => {
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-selected" } as never);
    vi.mocked(api.executeArchiveExtraction).mockResolvedValueOnce({
      phase: "completed",
      checkpoint_json: JSON.stringify({}),
    } as never);
    const destination = physicalLocation("conn-1", "output");

    await expect(
      startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
        source: archiveLocation,
        destination,
        selectedMemberPaths: ["docs", "docs/readme.txt"],
      }).result
    ).resolves.toMatchObject({ status: "completed" });

    expect(api.prepareArchiveOperation).toHaveBeenCalledWith(
      expect.objectContaining({ selected_member_paths: ["docs", "docs/readme.txt"] })
    );
  });

  it("resumes a paused direct-local extraction through the Companion decision endpoint", async () => {
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    vi.mocked(api.startLocalArchiveExtraction).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 1,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );
    vi.mocked(api.waitForLocalArchiveExecution)
      .mockResolvedValueOnce(
        createMockLocalArchiveExecution({
          execution_id: "local-extract-1",
          phase: "awaiting_user_decision",
          revision: 2,
          progress: localArchiveProgress(),
          cancellation_requested: false,
          pendingDecision: {
            kind: "collision",
            source_session_id: "source-session-1",
            delivery_sequence: 1,
            decision_revision: 1,
            member_path: "source.txt",
            is_directory: false,
            source: { path: "source.txt", size: 5, modified_at: "2025-01-01T12:00:00Z" },
            target: { path: "renamed.txt", size: 10, modified_at: "2025-01-02T12:00:00Z" },
            allowed_actions: ["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"],
          },
        })
      )
      .mockResolvedValueOnce(
        createMockLocalArchiveExecution({
          execution_id: "local-extract-1",
          phase: "completed",
          revision: 4,
          progress: localArchiveProgress(1),
          cancellation_requested: false,
          aggregate_counters: extractionAggregate(1, 0, 5),
        })
      );
    vi.mocked(api.decideLocalArchiveExecution).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 3,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: localArchiveLocation,
      destination: physicalLocation("local-drive:c", "archives/one"),
    });

    await expect(execution.result).resolves.toMatchObject({
      status: "awaiting-decision",
      conflicts: [archiveConflict("source.txt", "archives/one/renamed.txt")],
      allowedActions: ["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"],
    });
    await expect(execution.decide("replace_older", "source.txt")).resolves.toMatchObject({
      status: "completed",
      summary: { filesExtracted: 1 },
    });
    expect(api.decideLocalArchiveExecution).toHaveBeenCalledWith(
      "local-drive:c",
      "local-extract-1",
      2,
      "source-session-1",
      1,
      1,
      "source.txt",
      "replace_older"
    );
  });

  it("retries a paused direct-local member error through the Companion decision endpoint", async () => {
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    vi.mocked(api.startLocalArchiveExtraction).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 1,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );
    vi.mocked(api.waitForLocalArchiveExecution)
      .mockResolvedValueOnce(
        createMockLocalArchiveExecution({
          execution_id: "local-extract-1",
          phase: "awaiting_user_decision",
          revision: 2,
          progress: localArchiveProgress(),
          cancellation_requested: false,
          pendingDecision: {
            kind: "member_error",
            source_session_id: "source-session-1",
            delivery_sequence: 1,
            decision_revision: 1,
            member_path: "source.txt",
            target_path: "archives/one/source.txt",
            message: "archive member integrity check failed",
            partial_output: true,
            allowed_actions: ["retry", "ignore"],
          },
        })
      )
      .mockResolvedValueOnce(
        createMockLocalArchiveExecution({
          execution_id: "local-extract-1",
          phase: "completed",
          revision: 4,
          progress: localArchiveProgress(1),
          cancellation_requested: false,
          aggregate_counters: extractionAggregate(1, 0, 5),
        })
      );
    vi.mocked(api.decideLocalArchiveExecution).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 3,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: localArchiveLocation,
      destination: physicalLocation("local-drive:c", "archives/one"),
    });

    await expect(execution.result).resolves.toMatchObject({
      status: "awaiting-member-error",
      error: {
        memberPath: "source.txt",
        targetPath: "archives/one/source.txt",
        partialOutput: true,
      },
    });
    await expect(execution.decide("retry", "source.txt")).resolves.toMatchObject({
      status: "completed",
      summary: { filesExtracted: 1 },
    });
    expect(api.decideLocalArchiveExecution).toHaveBeenCalledWith(
      "local-drive:c",
      "local-extract-1",
      2,
      "source-session-1",
      1,
      1,
      "source.txt",
      "retry"
    );
  });

  it("cancels a direct-local ZIP extraction through its execution handle", async () => {
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    vi.mocked(api.startLocalArchiveExtraction).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 1,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );
    vi.mocked(api.cancelLocalArchiveExecutionWithRevisionRetry).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 2,
        progress: localArchiveProgress(),
        cancellation_requested: true,
      })
    );
    vi.mocked(api.waitForLocalArchiveExecution).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "cancelled",
        revision: 3,
        progress: localArchiveProgress(),
        cancellation_requested: true,
      })
    );

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: localArchiveLocation,
      destination: physicalLocation("local-drive:c", "archives/one"),
    });
    await execution.cancel();

    await expect(execution.result).resolves.toEqual({ status: "cancelled" });
    expect(api.cancelLocalArchiveExecutionWithRevisionRetry).toHaveBeenCalledWith("local-drive:c", "local-extract-1", 1);
  });

  it("falls back to general cancellation when a paused server decision becomes stale", async () => {
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-1" } as never);
    vi.mocked(api.executeArchiveExtraction).mockResolvedValueOnce({
      phase: "awaiting_user_decision",
    } as never);
    vi.mocked(api.getArchiveLiveExtractionStatus).mockResolvedValueOnce(
      liveExtractionStatus(liveCollision("docs/readme.txt", "output/docs/readme.txt")) as never
    );
    vi.mocked(api.decideArchiveExtraction).mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
    vi.mocked(api.cancelArchiveOperation).mockResolvedValueOnce({ phase: "streaming" } as never);

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: archiveLocation,
      destination: physicalLocation("conn-1", "output"),
    });

    await expect(execution.result).resolves.toMatchObject({ status: "awaiting-decision" });
    await expect(execution.cancel()).resolves.toBeUndefined();

    expect(api.decideArchiveExtraction).toHaveBeenCalledWith("extract-1", "cancel");
    expect(api.cancelArchiveOperation).toHaveBeenCalledWith("extract-1");
    vi.clearAllMocks();
  });

  it("uses the shared direct-local cancellation helper after a progress revision race", async () => {
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    vi.mocked(api.startLocalArchiveExtraction).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 1,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );
    vi.mocked(api.cancelLocalArchiveExecutionWithRevisionRetry).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 3,
        progress: localArchiveProgress(),
        cancellation_requested: true,
      })
    );
    vi.mocked(api.waitForLocalArchiveExecution).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "cancelled",
        revision: 4,
        progress: localArchiveProgress(),
        cancellation_requested: true,
      })
    );

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: localArchiveLocation,
      destination: physicalLocation("local-drive:c", "archives/one"),
    });
    await execution.cancel();

    await expect(execution.result).resolves.toEqual({ status: "cancelled" });
    expect(api.cancelLocalArchiveExecutionWithRevisionRetry).toHaveBeenCalledWith("local-drive:c", "local-extract-1", 1);
  });

  it("routes a local archive to an SMB destination through the Companion", async () => {
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-1" } as never);
    vi.mocked(api.extractLocalArchiveToSmb).mockResolvedValueOnce(extractionAggregate() as never);

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: localArchiveLocation,
      destination: physicalLocation("conn-1", "output"),
      selectedMemberPaths: ["docs/readme.txt"],
    });

    await expect(execution.result).resolves.toMatchObject({
      status: "completed",
      filesSkipped: 0,
      summary: { filesSkipped: 0, filesReplaced: 0, partialMembers: 0 },
    });
    expect(api.extractLocalArchiveToSmb).toHaveBeenCalledWith("local-drive:c", "archives/one.zip", "extract-1");
    expect(api.prepareArchiveOperation).toHaveBeenCalledWith(expect.objectContaining({ selected_member_paths: ["docs/readme.txt"] }));
  });

  it("resumes a paused local-to-SMB extraction through the Companion", async () => {
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-1" } as never);
    vi.mocked(api.getArchiveCompanionSession).mockResolvedValue({ token: "session-token" } as never);
    vi.mocked(api.extractLocalArchiveToSmb)
      .mockResolvedValueOnce({
        ...extractionAggregate(0, 1),
        phase: "awaiting_user_decision",
      } as never)
      .mockResolvedValueOnce(extractionAggregate(1, 1, 5) as never);
    vi.mocked(api.getLocalArchiveRelayExtractionStatus).mockResolvedValueOnce({
      source_session_id: "source-session-1",
      phase: "awaiting_decision",
      aggregate_counters: {
        members_processed: 0,
        members_completed: 0,
        members_skipped: 0,
        members_failed: 0,
        files_extracted: 0,
        directories_created: 1,
        extracted_bytes: 0,
        files_replaced: 0,
      },
      pending_decision: liveCollision("readme.txt", "output/readme.txt"),
    } as never);
    vi.mocked(api.decideLocalArchiveRelayExtraction).mockResolvedValueOnce({
      ...extractionAggregate(1, 1, 5),
    } as never);

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: localArchiveLocation,
      destination: physicalLocation("conn-1", "output"),
      selectedMemberPaths: ["readme.txt"],
    });

    await expect(execution.result).resolves.toMatchObject({
      status: "awaiting-decision",
      conflicts: [archiveConflict("readme.txt", "output/readme.txt")],
      allowedActions: ["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"],
    });
    await expect(execution.decide("skip_all")).resolves.toMatchObject({ status: "completed", summary: { filesExtracted: 1 } });
    expect(api.prepareArchiveOperation).toHaveBeenCalledWith(expect.objectContaining({ selected_member_paths: ["readme.txt"] }));
    expect(api.decideLocalArchiveRelayExtraction).toHaveBeenCalledWith(
      "local-drive:c",
      "extract-1",
      "source-session-1",
      1,
      1,
      "skip_all",
      "readme.txt",
      undefined
    );
    expect(api.executeArchiveExtraction).not.toHaveBeenCalled();
  });

  it("routes an SMB archive to a local destination through the Companion", async () => {
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-1" } as never);
    vi.mocked(api.getArchiveCompanionSession).mockResolvedValueOnce({ token: "session-token" } as never);
    vi.mocked(api.extractSmbArchiveToLocal).mockResolvedValueOnce(extractionAggregate() as never);

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: archiveLocation,
      destination: physicalLocation("local-drive:c", "output"),
      selectedMemberPaths: ["docs/readme.txt"],
    });

    await expect(execution.result).resolves.toMatchObject({
      status: "completed",
      filesSkipped: 0,
      summary: { filesSkipped: 0, filesReplaced: 0, partialMembers: 0 },
    });
    expect(api.extractSmbArchiveToLocal).toHaveBeenCalledWith("local-drive:c", "output", "extract-1");
    expect(api.prepareArchiveOperation).toHaveBeenCalledWith(expect.objectContaining({ selected_member_paths: ["docs/readme.txt"] }));
  });

  it("resumes a paused SMB-to-local extraction through the Companion", async () => {
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-1" } as never);
    vi.mocked(api.getArchiveCompanionSession).mockResolvedValue({ token: "session-token" } as never);
    vi.mocked(api.extractSmbArchiveToLocal)
      .mockResolvedValueOnce({
        ...extractionAggregate(0, 1),
        phase: "awaiting_user_decision",
      } as never)
      .mockResolvedValueOnce(extractionAggregate(1, 1, 5) as never);
    vi.mocked(api.getArchiveLiveExtractionStatus).mockResolvedValueOnce(
      liveExtractionStatus(liveCollision("readme.txt", "readme.txt")) as never
    );
    vi.mocked(api.decideArchiveExtraction).mockResolvedValueOnce({ phase: "streaming" } as never);

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: archiveLocation,
      destination: physicalLocation("local-drive:c", "output"),
    });

    await expect(execution.result).resolves.toMatchObject({
      status: "awaiting-decision",
      conflicts: [archiveConflict("readme.txt", "output/readme.txt")],
    });
    await expect(execution.decide("skip_all")).resolves.toMatchObject({ status: "completed", summary: { filesExtracted: 1 } });
    expect(vi.mocked(api.extractSmbArchiveToLocal).mock.calls.slice(-2)).toEqual([
      ["local-drive:c", "output", "extract-1"],
      ["local-drive:c", "output", "extract-1"],
    ]);
    expect(api.decideArchiveExtraction).toHaveBeenCalledWith("extract-1", "skip_all", "readme.txt", undefined, {
      sourceSessionId: "source-session-1",
      deliverySequence: 1,
      decisionRevision: 1,
    });
    expect(api.executeArchiveExtraction).not.toHaveBeenCalled();
  });

  it("extracts ZIP members across local drives and distinct SMB connections", async () => {
    vi.clearAllMocks();
    const localArchiveLocation = virtualLocation("zip", "local-drive:c", physicalLocation("local-drive:c", "archives/one.zip"), "");
    const otherSmbArchiveLocation = virtualLocation("zip", "conn-1", physicalLocation("conn-1", "archives/one.zip"), "");
    vi.mocked(api.startLocalArchiveExtraction).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "streaming",
        revision: 1,
        progress: localArchiveProgress(),
        cancellation_requested: false,
      })
    );
    vi.mocked(api.waitForLocalArchiveExecution).mockResolvedValueOnce(
      createMockLocalArchiveExecution({
        execution_id: "local-extract-1",
        phase: "completed",
        revision: 2,
        progress: localArchiveProgress(),
        cancellation_requested: false,
        aggregate_counters: extractionAggregate(),
      })
    );

    await expect(
      startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
        source: localArchiveLocation,
        destination: physicalLocation("local-drive:d", "output"),
      }).result
    ).resolves.toMatchObject({ status: "completed" });
    expect(api.startLocalArchiveExtraction).toHaveBeenCalledWith("local-drive:c", "archives/one.zip", "output", undefined, "local-drive:d");
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-remote-1" } as never);
    vi.mocked(api.executeArchiveExtraction).mockResolvedValueOnce({
      phase: "completed",
      checkpoint_json: JSON.stringify({ version: 2, aggregate_counters: extractionAggregate(1, 1, 5) }),
    } as never);
    await expect(
      startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
        source: otherSmbArchiveLocation,
        destination: physicalLocation("conn-2", "output"),
      }).result
    ).resolves.toMatchObject({ status: "completed", summary: { filesExtracted: 1, directoriesCreated: 1 } });
    expect(api.prepareArchiveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        source_connection_id: "conn-1",
        destination_connection_id: "conn-2",
      })
    );
    expect(api.executeArchiveExtraction).toHaveBeenCalledWith("extract-remote-1");
  });

  it("preserves a server collision decision and resumes the same extraction operation", async () => {
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-1" } as never);
    vi.mocked(api.executeArchiveExtraction)
      .mockResolvedValueOnce({
        phase: "awaiting_user_decision",
      } as never)
      .mockResolvedValueOnce({
        phase: "awaiting_user_decision",
      } as never)
      .mockResolvedValueOnce({
        phase: "completed",
        checkpoint_json: JSON.stringify({ version: 2, aggregate_counters: { members_skipped: 2 } }),
      } as never);
    vi.mocked(api.getArchiveLiveExtractionStatus)
      .mockResolvedValueOnce(liveExtractionStatus(liveCollision("docs/readme.txt", "output/docs/readme.txt")) as never)
      .mockResolvedValueOnce(liveExtractionStatus(liveCollision("images/cover.png", "output/images/cover.png", 2)) as never);
    vi.mocked(api.decideArchiveExtraction)
      .mockResolvedValueOnce({ phase: "streaming" } as never)
      .mockResolvedValueOnce({ phase: "streaming" } as never);

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: archiveLocation,
      destination: physicalLocation("conn-1", "output"),
    });

    await expect(execution.result).resolves.toEqual({
      status: "awaiting-decision",
      allowedActions: ["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"],
      conflicts: [archiveConflict("docs/readme.txt", "output/docs/readme.txt")],
    });
    await expect(execution.decide("skip", "docs/readme.txt")).resolves.toEqual({
      status: "awaiting-decision",
      allowedActions: ["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"],
      conflicts: [archiveConflict("images/cover.png", "output/images/cover.png")],
    });
    await expect(execution.decide("replace_older", "images/cover.png")).resolves.toMatchObject({
      status: "completed",
      filesSkipped: 2,
      summary: { filesSkipped: 2, filesReplaced: 0, partialMembers: 0 },
    });

    expect(api.decideArchiveExtraction).toHaveBeenNthCalledWith(1, "extract-1", "skip", "docs/readme.txt", undefined, {
      sourceSessionId: "source-session-1",
      deliverySequence: 1,
      decisionRevision: 1,
    });
    expect(api.decideArchiveExtraction).toHaveBeenNthCalledWith(2, "extract-1", "replace_older", "images/cover.png", undefined, {
      sourceSessionId: "source-session-1",
      deliverySequence: 2,
      decisionRevision: 2,
    });
    expect(api.executeArchiveExtraction).toHaveBeenNthCalledWith(3, "extract-1");
  });

  it("preserves a retryable member error and resumes after an ignore decision", async () => {
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-1" } as never);
    vi.mocked(api.executeArchiveExtraction)
      .mockResolvedValueOnce({
        phase: "awaiting_user_decision",
      } as never)
      .mockResolvedValueOnce({
        phase: "completed",
        checkpoint_json: JSON.stringify({ version: 2, aggregate_counters: { members_skipped: 1 } }),
      } as never);
    vi.mocked(api.getArchiveLiveExtractionStatus).mockResolvedValueOnce(
      liveExtractionStatus({
        revision: 1,
        kind: "member_error",
        member_path: "docs/readme.txt",
        target_path: "output/docs/readme.txt",
        message: "Disk full",
        delivery_sequence: 1,
        is_directory: false,
        allowed_actions: ["retry", "ignore"],
      }) as never
    );
    vi.mocked(api.decideArchiveExtraction).mockResolvedValueOnce({ phase: "streaming" } as never);

    const execution = startArchiveExtraction(createStorageBackedTestContentProviderRegistry(), {
      source: archiveLocation,
      destination: physicalLocation("conn-1", "output"),
    });

    await expect(execution.result).resolves.toEqual({
      status: "awaiting-member-error",
      error: {
        memberPath: "docs/readme.txt",
        targetPath: "output/docs/readme.txt",
        message: "Disk full",
        partialOutput: true,
      },
    });
    await expect(execution.decide("ignore", "docs/readme.txt")).resolves.toMatchObject({
      status: "completed",
      filesSkipped: 1,
      summary: { filesSkipped: 1, filesReplaced: 0, partialMembers: 0 },
    });

    expect(api.decideArchiveExtraction).toHaveBeenCalledWith("extract-1", "ignore", "docs/readme.txt", undefined, {
      sourceSessionId: "source-session-1",
      deliverySequence: 1,
      decisionRevision: 1,
    });
  });

  it("reads physical raw content from the original-byte endpoint", async () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    const blob = new Blob(["original"]);
    vi.mocked(api.getOriginalFileBlob).mockResolvedValueOnce(blob);

    await expect(
      readContent(
        { kind: "physical", location: physicalLocation("conn-1", "photos"), path: "photos/photo.jxl" },
        { kind: "raw" },
        undefined,
        providers
      )
    ).resolves.toBe(blob);

    expect(api.getOriginalFileBlob).toHaveBeenCalledWith("conn-1", "photos/photo.jxl", undefined);
    expect(api.getFileBlob).not.toHaveBeenCalled();
  });

  it("reuses a virtual source for another member in the same provider", async () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    const blob = new Blob(["document"]);
    vi.mocked(api.getArchiveMember).mockResolvedValueOnce(blob);

    await expect(
      readVirtualContent(virtualItemHandle(archiveLocation, "images/photo.png"), "docs/readme.md", { download: true }, providers)
    ).resolves.toBe(blob);
    expect(api.getArchiveMember).toHaveBeenCalledWith("conn-1", "archives/one.zip", "docs/readme.md", {
      download: true,
      request: { kind: "raw" },
      signal: undefined,
    });
  });

  it("uses the same image request for physical and virtual viewer sources", async () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    const physicalBlob = new Blob(["physical"]);
    const archiveBlob = new Blob(["archive"]);
    vi.mocked(api.getImageBlob).mockResolvedValueOnce(physicalBlob);
    vi.mocked(api.getArchiveMember).mockResolvedValueOnce(archiveBlob);
    const request = { kind: "image", viewportWidth: 1280, viewportHeight: 720 } as const;

    await expect(readViewerContent("conn-1", "photos/photo.jxl", request, undefined, providers)).resolves.toBe(physicalBlob);
    await expect(
      readViewerContent(
        "conn-1",
        "images/photo.jxl",
        request,
        { virtualSource: virtualItemHandle(archiveLocation, "images/photo.jxl") },
        providers
      )
    ).resolves.toBe(archiveBlob);

    expect(api.getImageBlob).toHaveBeenCalledWith("conn-1", "photos/photo.jxl", {
      signal: undefined,
      viewportWidth: 1280,
      viewportHeight: 720,
      no_resizing: undefined,
    });
    expect(api.getArchiveMember).toHaveBeenCalledWith("conn-1", "archives/one.zip", "images/photo.jxl", {
      download: undefined,
      request,
      signal: undefined,
    });
  });

  it("starts physical viewer editing through the resolved storage backend", async () => {
    const target = { kind: "smb" as const, connectionId: "conn-1" };
    const source = {
      target,
      path: "/docs/readme.md",
      resolvedTarget: { target, connection: null, capabilitySnapshot: {} as never },
    };
    const session = { heartbeat: vi.fn(), writeText: vi.fn(), release: vi.fn() };
    const begin = vi.fn().mockResolvedValue({ kind: "acquired", session });
    const registry = {
      resolveItem: vi.fn(() => source),
      getBackend: vi.fn(() => ({ editing: { begin } })),
    };

    const result = await beginViewerTextEdit("conn-1", "/docs/readme.md", createStorageBackedContentProviderRegistry(registry as never));

    expect(registry.resolveItem).toHaveBeenCalledWith({ connectionId: "conn-1", path: "/docs/readme.md" });
    expect(begin).toHaveBeenCalledWith(source);
    expect(result).toEqual({ kind: "acquired", session });
  });

  it("invalidates physical and virtual PDF derivatives through their providers", async () => {
    const providers = createStorageBackedTestContentProviderRegistry();
    const screenProfile = { width: 1280, height: 720, zoomPercent: 200 };

    await invalidateViewerPdfDerivative("conn-1", "docs/physical.pdf", screenProfile, undefined, providers);
    await invalidateViewerPdfDerivative(
      "conn-1",
      "docs/inside.pdf",
      screenProfile,
      virtualItemHandle(archiveLocation, "docs/inside.pdf"),
      providers
    );

    expect(api.invalidatePdfDerivative).toHaveBeenCalledWith("conn-1", "docs/physical.pdf", screenProfile);
    expect(api.invalidateArchiveMemberPdfDerivative).toHaveBeenCalledWith("conn-1", "archives/one.zip", "docs/inside.pdf", screenProfile);
  });
});
