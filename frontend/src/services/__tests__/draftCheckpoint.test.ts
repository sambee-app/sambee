import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getIdentity, getUserId } = vi.hoisted(() => ({ getIdentity: vi.fn(), getUserId: vi.fn() }));
vi.mock("../authSession", () => ({ authSession: { getIdentity, getUserId } }));

import {
  createDraftCheckpointController,
  DRAFT_CHECKPOINT_LAG_MS,
  DRAFT_CHECKPOINT_START_MS,
  type DraftCheckpointContent,
} from "../draftCheckpoint";
import { clearDraft, loadDraft } from "../draftRecovery";

const USER_ID = "checkpoint-user";
const CONNECTION_ID = "connection";
const PATH = "notes/a.md";
const content = (value: string): DraftCheckpointContent => ({ baseline: "saved", content: value });

function deferredSnapshot() {
  let resolve!: (snapshot: DraftCheckpointContent) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DraftCheckpointContent>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("revisioned draft checkpoints", () => {
  let controller: ReturnType<typeof createDraftCheckpointController>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    getUserId.mockReturnValue(USER_ID);
    getIdentity.mockImplementation(() => ({ userId: getUserId(), epoch: 0 }));
    controller = createDraftCheckpointController(CONNECTION_ID, PATH, "markdown");
  });

  afterEach(() => {
    controller.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("coalesces sustained edits without resetting the oldest edit's start deadline", async () => {
    const obsolete = vi.fn(async () => content("obsolete"));
    const latest = vi.fn(async () => content("latest"));
    controller.request(1, obsolete);
    await vi.advanceTimersByTimeAsync(DRAFT_CHECKPOINT_START_MS / 2);
    controller.request(2, latest);
    await vi.advanceTimersByTimeAsync(DRAFT_CHECKPOINT_START_MS / 2);

    expect(obsolete).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(controller.getOutcome()).toEqual({ saved: true, revision: 2 });
    expect(loadDraft(CONNECTION_ID, PATH, "markdown")?.content).toBe("latest");
  });

  it("flushes the captured latest revision immediately rather than waiting for the start timer", async () => {
    controller.request(1, async () => content("latest edit"));

    await expect(controller.flush()).resolves.toEqual({ saved: true, revision: 1 });
    expect(loadDraft(CONNECTION_ID, PATH, "markdown")?.content).toBe("latest edit");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("performs no redundant persistence when flushing an untouched session", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem");

    await expect(controller.flush()).resolves.toEqual({ saved: true, revision: null });
    expect(write).not.toHaveBeenCalled();
  });

  it("waits for pending latest edits when an older snapshot is already in flight", async () => {
    const older = deferredSnapshot();
    controller.request(1, () => older.promise);
    await vi.advanceTimersByTimeAsync(DRAFT_CHECKPOINT_START_MS);
    controller.request(2, async () => content("newer edit"));
    const flush = controller.flush();
    older.resolve(content("older edit"));

    await expect(flush).resolves.toEqual({ saved: true, revision: 2 });
    expect(loadDraft(CONNECTION_ID, PATH, "markdown")?.content).toBe("newer edit");
  });

  it("times out a stalled checkpoint, aborts preparation, and ignores late completion", async () => {
    const stalled = deferredSnapshot();
    let signal: AbortSignal | undefined;
    controller.request(1, (capturedSignal) => {
      signal = capturedSignal;
      return stalled.promise;
    });
    await vi.advanceTimersByTimeAsync(DRAFT_CHECKPOINT_LAG_MS);

    expect(controller.getOutcome()).toEqual({ saved: false, revision: 1, reason: "timeout" });
    expect(signal?.aborted).toBe(true);
    stalled.resolve(content("late edit"));
    await Promise.resolve();
    await Promise.resolve();
    expect(loadDraft(CONNECTION_ID, PATH, "markdown")).toBeNull();
  });

  it("keeps the latest live revision recoverable after a previous snapshot times out", async () => {
    const stalled = deferredSnapshot();
    controller.request(1, () => stalled.promise);
    await vi.advanceTimersByTimeAsync(DRAFT_CHECKPOINT_START_MS);
    controller.request(2, async () => content("latest edit"));
    const flush = controller.flush();
    await vi.advanceTimersByTimeAsync(DRAFT_CHECKPOINT_LAG_MS - DRAFT_CHECKPOINT_START_MS);

    await expect(flush).resolves.toEqual({ saved: true, revision: 2 });
    expect(loadDraft(CONNECTION_ID, PATH, "markdown")?.content).toBe("latest edit");
    stalled.reject(new Error("Late serializer failure"));
    await Promise.resolve();
  });

  it("reports serialization failure explicitly and allows a later recovery attempt", async () => {
    controller.request(1, async () => {
      throw new Error("Snapshot failed");
    });
    await expect(controller.flush()).resolves.toEqual({ saved: false, revision: 1, reason: "snapshot-failed" });
    controller.request(1, async () => content("retried edit"));
    await expect(controller.flush()).resolves.toEqual({ saved: true, revision: 1 });
  });

  it.each(["identity", "cleared", "disposed"])("rejects completion after authority is %s", async (change) => {
    const pending = deferredSnapshot();
    controller.request(1, () => pending.promise);
    const flush = controller.flush();
    await Promise.resolve();
    if (change === "identity") getUserId.mockReturnValue("other-user");
    if (change === "cleared") clearDraft(CONNECTION_ID, PATH, "markdown");
    if (change === "disposed") controller.dispose();
    pending.resolve(content("obsolete edit"));

    await expect(flush).resolves.toEqual({ saved: false, revision: 1, reason: change === "disposed" ? "disposed" : "stale-checkpoint" });
    expect(sessionStorage.length).toBe(0);
  });

  it("does not start queued serialization after disposal", async () => {
    const serialize = vi.fn(async () => content("obsolete edit"));
    controller.request(1, serialize);
    controller.dispose();
    await vi.advanceTimersByTimeAsync(DRAFT_CHECKPOINT_LAG_MS);

    expect(serialize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses elapsed time rather than wall-clock changes for checkpoint deadlines", async () => {
    controller.request(1, async () => content("latest edit"));
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(DRAFT_CHECKPOINT_START_MS);

    expect(controller.getOutcome()).toEqual({ saved: true, revision: 1 });
  });

  it.each(["no-user", "too-large", "storage-unavailable"])("preserves explicit %s failure feedback", async (reason) => {
    if (reason === "no-user") {
      controller.dispose();
      getUserId.mockReturnValue(null);
      controller = createDraftCheckpointController(CONNECTION_ID, PATH, "markdown");
    }
    if (reason === "storage-unavailable") {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("Storage unavailable", "SecurityError");
      });
    }
    const draftByteLimit = 2 * 1024 * 1024;
    controller.request(1, async () => content(reason === "too-large" ? "a".repeat(draftByteLimit + 1) : "latest edit"));

    await expect(controller.flush()).resolves.toEqual({ saved: false, revision: 1, reason });
    expect(sessionStorage.length).toBe(0);
  });

  it("does not invoke a serializer disposed before its first microtask", async () => {
    const serialize = vi.fn(async () => content("obsolete edit"));
    controller.request(1, serialize);
    const flush = controller.flush();
    controller.dispose();

    await expect(flush).resolves.toEqual({ saved: false, revision: 1, reason: "disposed" });
    expect(serialize).not.toHaveBeenCalled();
  });
});
