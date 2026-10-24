import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getIdentity, getUserId } = vi.hoisted(() => ({ getIdentity: vi.fn(), getUserId: vi.fn() }));

vi.mock("../authSession", () => ({ authSession: { getIdentity, getUserId } }));

import {
  clearCurrentUserDrafts,
  clearDraft,
  createDraftCheckpointSession,
  DRAFT_RECOVERY_CHANGED_EVENT,
  getUnsavedDraftsForConnection,
  loadDraft,
  purgeExpiredDraftsForCurrentUser,
  registerDraftSnapshot,
  saveDraft,
  snapshotRegisteredDrafts,
} from "../draftRecovery";

const USER_ID = "test-user";
const CONNECTION_ID = "connection";
const DRAFT_BYTE_LIMIT = 2 * 1024 * 1024;

describe("draft recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
    getUserId.mockReturnValue(USER_ID);
    getIdentity.mockImplementation(() => ({ userId: getUserId(), epoch: 0 }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("acknowledges a snapshot only after its exact content is stored", () => {
    const content = "latest edit\n\tincluding whitespace";

    expect(saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", content)).toEqual({ saved: true });
    expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")).toEqual(
      expect.objectContaining({ baseline: "saved", content, updatedAt: Date.now() })
    );
  });

  it("rejects an older deferred checkpoint after a newer revision is acknowledged", async () => {
    const session = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    try {
      const older = session.capture(1);
      const newer = session.capture(2);
      let finishOlder!: () => void;
      const pending = new Promise<void>((resolve) => {
        finishOlder = resolve;
      }).then(() => session.commit(older, "saved", "older edit"));

      expect(session.commit(newer, "saved", "newer edit")).toEqual({ saved: true });
      finishOlder();
      await expect(pending).resolves.toEqual({ saved: false, reason: "stale-checkpoint" });
      expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")?.content).toBe("newer edit");
    } finally {
      session.dispose();
    }
  });

  it.each(["other-account", "same-account-new-epoch"])("rejects captured authority after %s", (change) => {
    const session = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    const checkpoint = session.capture(0);
    try {
      if (change === "other-account") getUserId.mockReturnValue("other-user");
      else getIdentity.mockReturnValue({ userId: USER_ID, epoch: 1 });
      expect(session.commit(checkpoint, "saved", "obsolete edit")).toEqual({ saved: false, reason: "stale-checkpoint" });
      expect(sessionStorage.length).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it("rejects a closed session when a reopened document reuses revision numbers", () => {
    const oldSession = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    const oldCheckpoint = oldSession.capture(0);
    const newSession = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    try {
      oldSession.dispose();
      expect(newSession.commit(newSession.capture(0), "saved", "new session edit")).toEqual({ saved: true });
      expect(oldSession.commit(oldCheckpoint, "saved", "old session edit")).toEqual({ saved: false, reason: "stale-checkpoint" });
      expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")?.content).toBe("new session edit");
    } finally {
      oldSession.dispose();
      newSession.dispose();
    }
  });

  it.each(["single", "all"])("invalidates pending writes when clearing %s drafts without stored content", (scope) => {
    const session = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    const checkpoint = session.capture(0);
    try {
      if (scope === "single") clearDraft(CONNECTION_ID, "notes/./a.md", "markdown");
      else clearCurrentUserDrafts();
      expect(session.commit(checkpoint, "saved", "obsolete edit")).toEqual({ saved: false, reason: "stale-checkpoint" });
      expect(sessionStorage.length).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it("keeps a recreated draft safe from checkpoints captured before clearing", () => {
    const session = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    const checkpoint = session.capture(1);
    try {
      clearDraft(CONNECTION_ID, "notes/a.md", "markdown");
      saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "recreated draft");
      expect(session.commit(checkpoint, "saved", "obsolete draft")).toEqual({ saved: false, reason: "stale-checkpoint" });
      expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")?.content).toBe("recreated draft");
    } finally {
      session.dispose();
    }
  });

  it("allows retry after storage failure without acknowledging the failed revision", () => {
    const session = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    const checkpoint = session.capture(1);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });
    try {
      expect(session.commit(checkpoint, "saved", "latest edit")).toEqual({ saved: false, reason: "storage-unavailable" });
      expect(session.commit(checkpoint, "saved", "latest edit")).toEqual({ saved: true });
      expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")?.content).toBe("latest edit");
    } finally {
      write.mockRestore();
      session.dispose();
    }
  });

  it("rejects forged checkpoints and invalid revisions", () => {
    const session = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    try {
      expect(session.commit({ revision: 0 }, "saved", "forged edit")).toEqual({ saved: false, reason: "stale-checkpoint" });
      for (const revision of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
        expect(() => session.capture(revision)).toThrow(RangeError);
      }
      session.capture(2);
      expect(() => session.capture(1)).toThrow(RangeError);
    } finally {
      session.dispose();
    }
  });

  it("rechecks authority after synchronous invalid-draft cleanup callbacks", () => {
    const session = createDraftCheckpointSession(CONNECTION_ID, "notes/a.md", "markdown");
    const checkpoint = session.capture(0);
    sessionStorage.setItem(`sambee_oidc_draft:${USER_ID}:${CONNECTION_ID}:markdown:${encodeURIComponent("/notes/a.md")}`, "invalid");
    const changeAccount = () => getUserId.mockReturnValue("other-user");
    window.addEventListener(DRAFT_RECOVERY_CHANGED_EVENT, changeAccount);
    try {
      expect(session.commit(checkpoint, "saved", "obsolete edit")).toEqual({ saved: false, reason: "stale-checkpoint" });
      expect(sessionStorage.length).toBe(0);
    } finally {
      window.removeEventListener(DRAFT_RECOVERY_CHANGED_EVENT, changeAccount);
      session.dispose();
    }
  });

  it("reports missing identity without creating a checkpoint", () => {
    getUserId.mockReturnValue(null);

    expect(saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "draft")).toEqual({ saved: false, reason: "no-user" });
    expect(sessionStorage.length).toBe(0);
  });

  it("accepts the byte limit and preserves the last checkpoint when a later draft exceeds it", () => {
    const content = "a".repeat(DRAFT_BYTE_LIMIT);
    expect(saveDraft(CONNECTION_ID, "notes/a.txt", "text", "saved", content)).toEqual({ saved: true });

    expect(saveDraft(CONNECTION_ID, "notes/a.txt", "text", "saved", `${content}a`)).toEqual({ saved: false, reason: "too-large" });
    expect(loadDraft(CONNECTION_ID, "notes/a.txt", "text")?.content).toBe(content);
  });

  it("applies the draft limit to UTF-8 bytes rather than source length", () => {
    const content = "\u00e9".repeat(DRAFT_BYTE_LIMIT / 2 + 1);

    expect(content.length).toBeLessThan(DRAFT_BYTE_LIMIT);
    expect(saveDraft(CONNECTION_ID, "notes/a.txt", "text", "saved", content)).toEqual({ saved: false, reason: "too-large" });
    expect(sessionStorage.length).toBe(0);
  });

  it("reports failed persistence and retains the previous acknowledged checkpoint", () => {
    saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "acknowledged draft");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });

    expect(saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "latest edit")).toEqual({
      saved: false,
      reason: "storage-unavailable",
    });
    expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")?.content).toBe("acknowledged draft");
  });

  it("isolates current-user checkpoints and clearing from another user's drafts", () => {
    saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "first user's draft");
    getUserId.mockReturnValue("other-user");
    expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")).toBeNull();
    saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "second user's draft");
    clearCurrentUserDrafts();
    expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")).toBeNull();

    getUserId.mockReturnValue(USER_ID);
    expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")?.content).toBe("first user's draft");
  });

  it("runs registered lifecycle snapshots synchronously and stops after unregistering", () => {
    const snapshot = vi.fn(() => saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "latest edit"));
    const unregister = registerDraftSnapshot(snapshot);
    try {
      snapshotRegisteredDrafts();
      expect(snapshot).toHaveBeenCalledOnce();
      expect(loadDraft(CONNECTION_ID, "notes/a.md", "markdown")?.content).toBe("latest edit");
      unregister();
      snapshotRegisteredDrafts();
      expect(snapshot).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("enumerates only changed, valid drafts for a connection", () => {
    saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "local draft");
    saveDraft(CONNECTION_ID, "notes/b.txt", "text", "same", "same");
    saveDraft("other", "notes/c.txt", "text", "saved", "local draft");

    expect(getUnsavedDraftsForConnection(CONNECTION_ID)).toEqual([
      expect.objectContaining({ connectionId: CONNECTION_ID, editorType: "markdown", path: "/notes/a.md" }),
    ]);
  });

  it("notifies browser panes when a draft is saved or cleared", () => {
    const changed = vi.fn();
    window.addEventListener(DRAFT_RECOVERY_CHANGED_EVENT, changed);

    saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "local draft");
    saveDraft(CONNECTION_ID, "notes/a.md", "markdown", "saved", "updated local draft");
    clearDraft(CONNECTION_ID, "notes/a.md", "markdown");
    clearDraft(CONNECTION_ID, "notes/a.md", "markdown");

    expect(changed).toHaveBeenCalledTimes(2);
    window.removeEventListener(DRAFT_RECOVERY_CHANGED_EVENT, changed);
  });

  it("purges malformed and expired current-user drafts", () => {
    const changed = vi.fn();
    window.addEventListener(DRAFT_RECOVERY_CHANGED_EVENT, changed);
    const oldTime = Date.now() - 24 * 60 * 60 * 1000 - 1;
    sessionStorage.setItem(
      `sambee_oidc_draft:${USER_ID}:${CONNECTION_ID}:text:${encodeURIComponent("/expired.txt")}`,
      JSON.stringify({ baseline: "saved", content: "draft", updatedAt: oldTime })
    );
    sessionStorage.setItem(`sambee_oidc_draft:${USER_ID}:${CONNECTION_ID}:text:bad`, "not-json");

    purgeExpiredDraftsForCurrentUser();

    expect(getUnsavedDraftsForConnection(CONNECTION_ID)).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(DRAFT_RECOVERY_CHANGED_EVENT, changed);
  });

  it("removes a malformed requested draft safely", () => {
    sessionStorage.setItem(`sambee_oidc_draft:${USER_ID}:${CONNECTION_ID}:text:${encodeURIComponent("/bad.txt")}`, "not-json");

    expect(loadDraft(CONNECTION_ID, "bad.txt", "text")).toBeNull();
  });
});
