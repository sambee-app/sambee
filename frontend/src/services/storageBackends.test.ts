import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireTestValue } from "../test/helpers/assertions";
import api, { ExpiredEditLockError } from "./api";
import { authSession } from "./authSession";
import { clearEditLockRecovery } from "./editLockRecovery";
import { PreviewUnavailableError } from "./previewPolicy";
import { CompanionLocalBackend, SambeeSmbBackend } from "./storageBackends";

vi.mock("./api", () => ({
  ExpiredEditLockError: class ExpiredEditLockError extends Error {},
  default: {
    acquireEditLock: vi.fn(),
    getArchiveMember: vi.fn(),
    getImageBlob: vi.fn(),
    getPdfBlob: vi.fn(),
    heartbeatEditLock: vi.fn(),
    prepareArchiveOperation: vi.fn(),
    releaseEditLock: vi.fn(),
    writeTextWithEditLock: vi.fn(),
  },
}));

describe("edit-lock reload recovery", () => {
  const lock = {
    lock_id: "lock-1",
    lock_capability: "capability-1",
    operation_id: "operation-1",
    file_path: "docs/readme.md",
    locked_by: "alice",
    locked_at: "2026-10-19T12:00:00Z",
  };
  const target = { kind: "smb" as const, connectionId: "connection-1" };
  const source = {
    target,
    path: lock.file_path,
    resolvedTarget: { target, connection: { access_mode: "read_write" }, capabilitySnapshot: { companion: { status: "unavailable" } } },
  };
  const heldLocks = new Set<string>();
  let navigationType: string;
  const begin = async () => {
    const result = await new SambeeSmbBackend().editing.begin(source as never);
    if (result.kind !== "acquired") throw new Error("Expected acquired session");
    return result.session;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    heldLocks.clear();
    navigationType = "navigate";
    vi.spyOn(authSession, "getUserId").mockReturnValue("alice-id");
    vi.stubGlobal("performance", {
      getEntriesByType: () => [{ type: navigationType }],
    });
    vi.stubGlobal("navigator", {
      locks: {
        request: vi.fn(async (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
          if (heldLocks.has(name)) return callback(null);
          heldLocks.add(name);
          try {
            await callback({ name });
          } finally {
            heldLocks.delete(name);
          }
        }),
      },
    });
    vi.mocked(api.acquireEditLock).mockResolvedValue(lock);
    vi.mocked(api.heartbeatEditLock).mockResolvedValue();
    vi.mocked(api.releaseEditLock).mockResolvedValue();
    vi.mocked(api.writeTextWithEditLock).mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("resumes the same lease after F5 or an update reload without acquiring another", async () => {
    await begin();
    heldLocks.clear();
    navigationType = "reload";
    const resumed = await begin();
    expect(api.acquireEditLock).toHaveBeenCalledTimes(1);
    expect(api.heartbeatEditLock).toHaveBeenCalledWith(target.connectionId, source.path, expect.objectContaining(lockContext()));
    await resumed.writeText("updated");
    expect(api.writeTextWithEditLock).toHaveBeenCalledWith(target.connectionId, source.path, "updated", lockContext(), {
      mimeType: undefined,
    });
    await resumed.release();
    expect(sessionStorage.length).toBe(0);
  });

  function lockContext() {
    return { lock_id: lock.lock_id, operation_id: lock.operation_id, lock_capability: lock.lock_capability };
  }

  it("acquires a new lease when the saved lock has expired", async () => {
    await begin();
    heldLocks.clear();
    navigationType = "reload";
    vi.mocked(api.heartbeatEditLock).mockRejectedValueOnce(new ExpiredEditLockError());
    vi.mocked(api.acquireEditLock).mockResolvedValueOnce({ ...lock, lock_id: "replacement" });
    const resumed = await begin();
    expect(api.acquireEditLock).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(Object.keys(sessionStorage)[0]!)).toContain("replacement");
    await resumed.release();
  });

  it.each([new Error("Network unavailable"), { response: { status: 403 } }])(
    "does not acquire a replacement after a transient or permission failure: %j",
    async (error) => {
      await begin();
      heldLocks.clear();
      navigationType = "reload";
      vi.mocked(api.heartbeatEditLock).mockRejectedValueOnce(error);
      await expect(begin()).rejects.toEqual(error);
      expect(api.acquireEditLock).toHaveBeenCalledTimes(1);
      expect(sessionStorage.length).toBe(1);
      const resumed = await begin();
      await resumed.release();
    }
  );

  it("rejects a second tab even if it copied credentials and then reloaded", async () => {
    const original = await begin();
    navigationType = "reload";
    await expect(begin()).rejects.toThrow("another tab");
    expect(api.acquireEditLock).toHaveBeenCalledTimes(1);
    expect(api.heartbeatEditLock).not.toHaveBeenCalled();
    await original.release();
  });

  it("does not resume copied credentials on a fresh navigation", async () => {
    await begin();
    heldLocks.clear();
    const other = await begin();
    expect(api.acquireEditLock).toHaveBeenCalledTimes(2);
    expect(api.heartbeatEditLock).not.toHaveBeenCalled();
    await other.release();
  });

  it("does not reuse another user's saved credentials", async () => {
    await begin();
    heldLocks.clear();
    navigationType = "reload";
    vi.mocked(authSession.getUserId).mockReturnValue("bob-id");
    const other = await begin();
    expect(api.acquireEditLock).toHaveBeenCalledTimes(2);
    expect(api.heartbeatEditLock).not.toHaveBeenCalled();
    await other.release();
  });

  it("recovers a reload when sign-in is disabled", async () => {
    vi.mocked(authSession.getUserId).mockReturnValue(null);
    await begin();
    heldLocks.clear();
    navigationType = "reload";
    const resumed = await begin();
    expect(api.acquireEditLock).toHaveBeenCalledTimes(1);
    expect(api.heartbeatEditLock).toHaveBeenCalledTimes(1);
    await resumed.release();
  });

  it("retains credentials when release fails and clears them after a successful retry", async () => {
    const session = await begin();
    vi.mocked(api.releaseEditLock).mockRejectedValueOnce(new Error("Offline"));
    await expect(session.release()).rejects.toThrow("Offline");
    expect(sessionStorage.length).toBe(1);
    await session.release();
    expect(sessionStorage.length).toBe(0);
  });

  it("saves the replacement credentials after a write reacquires an expired lock", async () => {
    const session = await begin();
    vi.mocked(api.writeTextWithEditLock).mockRejectedValueOnce(new ExpiredEditLockError());
    vi.mocked(api.acquireEditLock).mockResolvedValueOnce({ ...lock, lock_id: "replacement" });
    await session.writeText("updated");
    expect(sessionStorage.getItem(Object.keys(sessionStorage)[0]!)).toContain("replacement");
    await session.release();
  });

  it("removes saved credentials on logout without removing other session data", async () => {
    const session = await begin();
    sessionStorage.setItem("other", "value");
    authSession.clear();
    expect(Object.keys(sessionStorage)).toEqual(["other"]);
    await session.release();
  });

  it("disables recovery safely when browser Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const session = await begin();
    expect(sessionStorage.length).toBe(0);
    await session.release();
  });

  it("continues editing when session storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    const session = await begin();
    await session.writeText("updated");
    await session.release();
  });

  it("discards malformed saved credentials", async () => {
    await begin();
    heldLocks.clear();
    navigationType = "reload";
    sessionStorage.setItem(Object.keys(sessionStorage)[0]!, "not json");
    const session = await begin();
    expect(api.acquireEditLock).toHaveBeenCalledTimes(2);
    await session.release();
    clearEditLockRecovery();
  });
});

describe("SambeeSmbBackend archive reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prepares selected ZIP members against their owning same-SMB archive", async () => {
    vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "operation-1" } as never);
    const target = { kind: "smb" as const, connectionId: "connection-1" };
    const resolvedTarget = { target, connection: null, capabilitySnapshot: {} as never };
    const request = {
      sources: [{ target, path: "archives/source.zip", resolvedTarget }],
      destination: { target, path: "archives", resolvedTarget },
      name: "selected.zip",
      selectedMemberPaths: ["inner/report.txt"],
    };

    await new SambeeSmbBackend().archiveCreation?.prepareCreate?.(request);
    expect(api.prepareArchiveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        source_path: "archives/source.zip",
        selected_member_paths: ["inner/report.txt"],
        destination_path: "archives/selected.zip",
      })
    );
    expect(JSON.parse(requireTestValue(vi.mocked(api.prepareArchiveOperation).mock.calls[0]![0].plan_json))).toEqual({
      source_paths: ["archives/source.zip"],
    });
    await expect(
      new SambeeSmbBackend().archiveCreation?.prepareCreate?.({
        ...request,
        destination: { ...request.destination, target: { kind: "smb", connectionId: "other" } },
      })
    ).rejects.toThrow("same-connection SMB destination");
  });

  it("preserves download intent when reading an archive member", async () => {
    const blob = new Blob(["original"]);
    vi.mocked(api.getArchiveMember).mockResolvedValueOnce(blob);
    const target = { kind: "smb" as const, connectionId: "connection-1" };
    const source = {
      target,
      path: "archives/photos.zip",
      resolvedTarget: { target, connection: null, capabilitySnapshot: {} as never },
    };

    await expect(
      new SambeeSmbBackend().archive?.readMember(source, "images/photo.jpg", { kind: "image" }, { download: true })
    ).resolves.toBe(blob);

    expect(api.getArchiveMember).toHaveBeenCalledWith("connection-1", "archives/photos.zip", "images/photo.jpg", {
      download: true,
      request: { kind: "image" },
      signal: undefined,
    });
  });

  it("binds SMB text writes to the acquired edit lease", async () => {
    const target = { kind: "smb" as const, connectionId: "connection-1" };
    const source = {
      target,
      path: "docs/readme.txt",
      resolvedTarget: {
        target,
        connection: { access_mode: "read_write" },
        capabilitySnapshot: { companion: { status: "unavailable" } },
      },
    };
    vi.mocked(api.acquireEditLock).mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "docs/readme.txt",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });

    const session = await new SambeeSmbBackend().editing?.begin(source as never);
    expect(session?.kind).toBe("acquired");
    if (session?.kind !== "acquired") throw new Error("Expected acquired edit session");

    await session.session.heartbeat();
    await session.session.writeText("updated", { mimeType: "text/plain;charset=utf-8" });
    await session.session.release();
    await session.session.release();

    expect(api.heartbeatEditLock).toHaveBeenCalledWith("connection-1", "docs/readme.txt", expect.objectContaining({ lock_id: "lock-1" }));
    expect(api.writeTextWithEditLock).toHaveBeenCalledWith(
      "connection-1",
      "docs/readme.txt",
      "updated",
      { lock_id: "lock-1", lock_capability: "capability-1", operation_id: "operation-1" },
      { mimeType: "text/plain;charset=utf-8" }
    );
    expect(api.releaseEditLock).toHaveBeenCalledTimes(1);
  });

  it("reacquires an expired edit lock and updates the session lease", async () => {
    const target = { kind: "smb" as const, connectionId: "connection-1" };
    const source = {
      target,
      path: "docs/readme.txt",
      resolvedTarget: {
        target,
        connection: { access_mode: "read_write" },
        capabilitySnapshot: { companion: { status: "unavailable" } },
      },
    };
    vi.mocked(api.acquireEditLock)
      .mockResolvedValueOnce({
        lock_id: "lock-1",
        lock_capability: "capability-1",
        operation_id: "operation-1",
        file_path: "docs/readme.txt",
        locked_by: "alice",
        locked_at: "2026-03-23T12:00:00Z",
      })
      .mockResolvedValueOnce({
        lock_id: "lock-2",
        lock_capability: "capability-2",
        operation_id: "operation-2",
        file_path: "docs/readme.txt",
        locked_by: "alice",
        locked_at: "2026-03-23T12:05:00Z",
      });
    vi.mocked(api.writeTextWithEditLock).mockRejectedValueOnce(new ExpiredEditLockError()).mockResolvedValueOnce(undefined);

    const session = await new SambeeSmbBackend().editing?.begin(source as never);
    if (session?.kind !== "acquired") throw new Error("Expected acquired edit session");

    await session.session.writeText("updated", { mimeType: "text/plain;charset=utf-8" });
    await session.session.heartbeat();
    await session.session.release();

    expect(api.acquireEditLock).toHaveBeenCalledTimes(2);
    expect(api.writeTextWithEditLock).toHaveBeenNthCalledWith(
      1,
      "connection-1",
      "docs/readme.txt",
      "updated",
      { lock_id: "lock-1", lock_capability: "capability-1", operation_id: "operation-1" },
      { mimeType: "text/plain;charset=utf-8" }
    );
    expect(api.writeTextWithEditLock).toHaveBeenNthCalledWith(
      2,
      "connection-1",
      "docs/readme.txt",
      "updated",
      { lock_id: "lock-2", lock_capability: "capability-2", operation_id: "operation-2" },
      { mimeType: "text/plain;charset=utf-8" }
    );
    expect(api.heartbeatEditLock).toHaveBeenCalledWith("connection-1", "docs/readme.txt", expect.objectContaining({ lock_id: "lock-2" }));
    expect(api.releaseEditLock).toHaveBeenCalledWith("connection-1", "docs/readme.txt", expect.objectContaining({ lock_id: "lock-2" }));
  });

  it("reacquires an expired Companion local-drive edit lock", async () => {
    const target = { kind: "local" as const, driveId: "c" };
    const source = {
      target,
      path: "docs/readme.md",
      resolvedTarget: {
        target,
        connection: null,
        capabilitySnapshot: { companion: { status: "paired" } },
      },
    };
    vi.mocked(api.acquireEditLock)
      .mockResolvedValueOnce({
        lock_id: "lock-1",
        lock_capability: "capability-1",
        operation_id: "operation-1",
        file_path: "docs/readme.md",
        locked_by: "alice",
        locked_at: "2026-03-23T12:00:00Z",
      })
      .mockResolvedValueOnce({
        lock_id: "lock-2",
        lock_capability: "capability-2",
        operation_id: "operation-2",
        file_path: "docs/readme.md",
        locked_by: "alice",
        locked_at: "2026-03-23T12:05:00Z",
      });
    vi.mocked(api.writeTextWithEditLock).mockRejectedValueOnce(new ExpiredEditLockError()).mockResolvedValueOnce(undefined);

    const session = await new CompanionLocalBackend().editing?.begin(source as never);
    if (session?.kind !== "acquired") throw new Error("Expected acquired edit session");

    await session.session.writeText("# Updated", { mimeType: "text/markdown;charset=utf-8" });
    await session.session.heartbeat();
    await session.session.release();

    expect(api.acquireEditLock).toHaveBeenCalledTimes(2);
    expect(api.writeTextWithEditLock).toHaveBeenNthCalledWith(
      1,
      "local-drive:c",
      "docs/readme.md",
      "# Updated",
      { lock_id: "lock-1", lock_capability: "capability-1", operation_id: "operation-1" },
      { mimeType: "text/markdown;charset=utf-8" }
    );
    expect(api.writeTextWithEditLock).toHaveBeenNthCalledWith(
      2,
      "local-drive:c",
      "docs/readme.md",
      "# Updated",
      { lock_id: "lock-2", lock_capability: "capability-2", operation_id: "operation-2" },
      { mimeType: "text/markdown;charset=utf-8" }
    );
    expect(api.heartbeatEditLock).toHaveBeenCalledWith("local-drive:c", "docs/readme.md", expect.objectContaining({ lock_id: "lock-2" }));
    expect(api.releaseEditLock).toHaveBeenCalledWith("local-drive:c", "docs/readme.md", expect.objectContaining({ lock_id: "lock-2" }));
  });

  it("retries an edit-lock release after a transient failure", async () => {
    const target = { kind: "smb" as const, connectionId: "connection-1" };
    const source = {
      target,
      path: "docs/readme.txt",
      resolvedTarget: {
        target,
        connection: { access_mode: "read_write" },
        capabilitySnapshot: { companion: { status: "unavailable" } },
      },
    };
    vi.mocked(api.acquireEditLock).mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "docs/readme.txt",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.mocked(api.releaseEditLock).mockRejectedValueOnce(new Error("Temporary network error")).mockResolvedValueOnce(undefined);

    const session = await new SambeeSmbBackend().editing?.begin(source as never);
    if (session?.kind !== "acquired") throw new Error("Expected acquired edit session");

    await expect(session.session.release()).rejects.toThrow("Temporary network error");
    await expect(session.session.release()).resolves.toBeUndefined();

    expect(api.releaseEditLock).toHaveBeenCalledTimes(2);
  });

  it("rejects local archive image conversions without calling the Companion", () => {
    const target = { kind: "local" as const, driveId: "c" };
    const source = {
      target,
      path: "archives/photos.zip",
      resolvedTarget: { target, connection: null, capabilitySnapshot: {} as never },
    };

    expect(() => new CompanionLocalBackend().archive?.readMember(source, "images/photo.jxl", { kind: "image" })).toThrow(
      PreviewUnavailableError
    );
    expect(api.getArchiveMember).not.toHaveBeenCalled();
  });

  it("allows local browser-native archive images as raw previews", async () => {
    const target = { kind: "local" as const, driveId: "c" };
    const source = {
      target,
      path: "archives/photos.zip",
      resolvedTarget: { target, connection: null, capabilitySnapshot: {} as never },
    };
    const blob = new Blob(["png"]);
    vi.mocked(api.getArchiveMember).mockResolvedValueOnce(blob);

    await expect(new CompanionLocalBackend().archive?.readMember(source, "images/photo.png", { kind: "image" })).resolves.toBe(blob);
    expect(api.getArchiveMember).toHaveBeenCalledWith("local-drive:c", "archives/photos.zip", "images/photo.png", {
      download: undefined,
      request: { kind: "image" },
      signal: undefined,
    });
  });

  it("rejects local archive PDF normalization without calling the Companion", () => {
    const target = { kind: "local" as const, driveId: "c" };
    const source = {
      target,
      path: "archives/reports.zip",
      resolvedTarget: { target, connection: null, capabilitySnapshot: {} as never },
    };
    vi.mocked(api.getArchiveMember).mockClear();

    expect(() => new CompanionLocalBackend().archive?.readMember(source, "report.pdf", { kind: "pdf", variant: "normalized" })).toThrow(
      PreviewUnavailableError
    );
    expect(api.getArchiveMember).not.toHaveBeenCalled();
  });
});
