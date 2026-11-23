import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCurrentBrowserSession } from "../../../services/accountSession";
import { authSession } from "../../../services/authSession";
import { createMockAuthToken } from "../../../test/fixtures/users";
import { mockWebLocks } from "../../../test/mocks/webLocks";
import type { BrowseRouteTarget } from "../routing";
import { createEmptyTabSession } from "../tabSessions";
import {
  CLOSED_WORKSPACE_TAB_BUDGET_BYTES,
  claimWorkspaceTabs,
  getStoredWorkspaceRoute,
  getWorkspaceBrowseIdentity,
  LEGACY_PANE_TABS_KEY,
  type PersistedWorkspaceTabsRecord,
  readWorkspacePageIds,
  resetPaneTabsStorageStateForTesting,
  resolveRestoredWorkspaceTabs,
  WORKSPACE_PAGE_HISTORY_KEY,
  WORKSPACE_PAGE_ID_KEY,
  WORKSPACE_TAB_CHANNEL,
  WORKSPACE_TAB_RECORD_PREFIX,
  type WorkspaceTabState,
} from "../workspaceTabStorage";

const target = (path: string): BrowseRouteTarget => ({ kind: "smb", targetId: "demo", path });
const route = (left: BrowseRouteTarget | null = null) => ({ left, right: null, activePaneId: "left" as const });
const key = (pageId: string | null) => WORKSPACE_TAB_RECORD_PREFIX + pageId;
const connections = [{ id: "smb-id", slug: "demo" }];
const tab = (id: string, connectionId = "smb-id", currentPath = id) => createEmptyTabSession(id, { connectionId, currentPath });
const state: WorkspaceTabState = {
  paneMode: "dual",
  activePaneId: "right",
  connections,
  leftTabs: [
    tab("folder"),
    tab("drive", "local-drive:d"),
    {
      ...tab("zip", "local-drive:d", "Downloads"),
      archiveLocation: { providerId: "zip", archivePath: "Downloads/data.zip", virtualPath: "docs" },
      sortBy: "size",
      sortDirection: "desc",
    },
    tab("missing", "missing-smb:unavailable"),
  ],
  leftSelectedTabId: "zip",
  rightTabs: [tab("right")],
  rightSelectedTabId: "right",
  fallbackTargets: new Map([["missing", { kind: "smb", targetId: "unavailable", path: "missing" }]]),
};

function seed(pageId: string, updatedAt: number, path = pageId, userScope: string | null = "alice") {
  const record: PersistedWorkspaceTabsRecord = {
    schemaVersion: 2,
    userScope,
    updatedAt,
    paneMode: "single",
    activePaneId: "left",
    left: { selectedTabId: "one", tabs: [{ id: "one", ...target(path) }] },
    right: null,
  };
  localStorage.setItem(key(pageId), JSON.stringify(record));
  return record;
}

describe("workspace tab storage", () => {
  const owners: AbortController[] = [];
  function start(incoming = route(), scope: string | null = authSession.getUserId()) {
    const owner = new AbortController();
    owners.push(owner);
    return { result: claimWorkspaceTabs(scope, incoming, owner.signal), close: () => owner.abort() };
  }
  const open = (incoming = route()) => start(incoming).result;

  beforeEach(() => {
    mockWebLocks();
    resetPaneTabsStorageStateForTesting();
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, "");
    authSession.setAuthenticated(createMockAuthToken({ user_id: "alice" }), false);
  });

  afterEach(() => {
    for (const owner of owners.splice(0)) owner.abort();
    authSession.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("writes compact descriptors only to localStorage and restores both panes through the page reference", async () => {
    history.replaceState({ usr: { caller: true }, key: "router", idx: 4 }, "");
    const original = start();
    const claim = await original.result;
    claim.save(state, vi.fn());
    expect(Object.keys(sessionStorage)).toEqual([WORKSPACE_PAGE_ID_KEY]);
    expect(history.state).toEqual({ usr: { caller: true }, key: "router", idx: 4, [WORKSPACE_PAGE_HISTORY_KEY]: [claim.pageId] });
    expect(claim.record?.left.tabs).toEqual([
      { id: "folder", kind: "smb", targetId: "demo", path: "folder" },
      { id: "drive", kind: "local", targetId: "d", path: "drive" },
      {
        id: "zip",
        kind: "local",
        targetId: "d",
        archive: { sourcePath: "Downloads/data.zip", virtualPath: "docs" },
        sortBy: "size",
        sortDirection: "desc",
      },
      { id: "missing", kind: "smb", targetId: "unavailable", path: "missing" },
    ]);
    original.close();
    sessionStorage.clear();
    const reload = await open();
    expect(reload.pageId).toBe(claim.pageId);
    expect(reload.fromClosed).toBe(false);
    expect(reload.record).toEqual(JSON.parse(localStorage.getItem(key(claim.pageId))!));
    const restored = resolveRestoredWorkspaceTabs(reload.record!, route(), connections);
    expect([...restored.left.sessions.values()]).toEqual(state.leftTabs.map((entry) => ({ ...entry, unmonitoredWhileHidden: true })));
    expect(restored.left.selectedTabId).toBe("zip");
    expect(restored.right?.orderedIds).toEqual(["right"]);
    expect(restored.unresolvedTargets).toEqual(state.fallbackTargets);
  });

  it("copies a live page to a new ID and saves each copy independently", async () => {
    const original = await open();
    original.save(state, vi.fn());
    const duplicate = await open();
    expect(duplicate.pageId).not.toBe(original.pageId);
    expect(duplicate.record?.left).toEqual(original.record?.left);
    duplicate.save({ ...state, leftTabs: [tab("copy")], leftSelectedTabId: "copy" }, vi.fn());
    expect(JSON.parse(localStorage.getItem(key(original.pageId))!).left.tabs).toHaveLength(4);
    expect(JSON.parse(localStorage.getItem(key(duplicate.pageId))!).left.tabs).toHaveLength(1);
  });

  it("prefers the URL match, then the newest available record, without sharing a claim", async () => {
    seed("older-match", 1, "match");
    seed("newest", 2);
    const [one, two] = await Promise.all([open(route(target("match"))), open(route(target("match")))]);
    expect([one.pageId, two.pageId]).toEqual(["older-match", "newest"]);
    expect(one.fromClosed && two.fromClosed).toBe(true);
  });

  it("restores each expired window's own background tabs when both windows have the same URL", async () => {
    const incoming = route(target("shared"));
    const recordA = seed("window-a", 1, "shared");
    const recordB = seed("window-b", 2, "shared");
    recordA.left.tabs.push({ id: "background-a", ...target("Private folder A") });
    recordB.left.tabs.push({ id: "background-b", ...target("Private folder B") });
    localStorage.setItem(key("window-a"), JSON.stringify(recordA));
    localStorage.setItem(key("window-b"), JSON.stringify(recordB));

    // Simulate two windows with shared localStorage and independent session and history state.
    async function expire(pageId: string) {
      sessionStorage.setItem(WORKSPACE_PAGE_ID_KEY, pageId);
      history.replaceState({ [WORKSPACE_PAGE_HISTORY_KEY]: pageId }, "");
      const owner = start(incoming);
      expect((await owner.result).pageId).toBe(pageId);
      authSession.clear();
      owner.close();
      const anonymous = start(incoming);
      expect((await anonymous.result).pageId).not.toBe(pageId);
      (await anonymous.result).save(state, vi.fn());
      const expired = { session: sessionStorage.getItem(WORKSPACE_PAGE_ID_KEY)!, history: history.state };
      anonymous.close();
      authSession.setAuthenticated(createMockAuthToken({ user_id: "alice" }), false);
      return expired;
    }

    const windowA = await expire("window-a");
    const windowB = await expire("window-b");

    // Window A signs in first. A fallback based on recency would select window B.
    sessionStorage.setItem(WORKSPACE_PAGE_ID_KEY, windowA.session);
    history.replaceState(null, "");
    const restoredA = await open(incoming);
    expect(restoredA.pageId).toBe("window-a");
    expect(restoredA.fromClosed).toBe(false);
    expect(restoredA.record?.left.tabs).toEqual(recordA.left.tabs);
    expect(readWorkspacePageIds()[0]).toBe("window-a");

    // Window B also gets its own tabs when only browser history survives.
    sessionStorage.clear();
    history.replaceState(windowB.history, "");
    const restoredB = await open(incoming);
    expect(restoredB.pageId).toBe("window-b");
    expect(restoredB.fromClosed).toBe(false);
    expect(restoredB.record?.left.tabs).toEqual(recordB.left.tabs);
  });

  it("selects an existing folder or adds a new one when claiming a closed workspace", async () => {
    const record = seed("closed", 1);
    record.left.tabs.push({ id: "background", ...target("background") });
    const existing = resolveRestoredWorkspaceTabs(record, route(target("background")), connections, true);
    expect(existing.left.selectedTabId).toBe("background");
    expect(existing.left.orderedIds).toEqual(["one", "background"]);
    const added = resolveRestoredWorkspaceTabs(record, route(target("bookmark")), connections, true);
    expect(added.left.orderedIds).toHaveLength(3);
    expect(added.left.sessions.get(added.left.selectedTabId)?.currentPath).toBe("bookmark");
    expect(added.left.sessions.get("one")?.currentPath).toBe("closed");
    const reload = resolveRestoredWorkspaceTabs(record, route(target("bookmark")), connections);
    expect(reload.left.orderedIds).toEqual(["one", "background"]);
    expect(reload.left.sessions.get("one")?.currentPath).toBe("bookmark");
  });

  it("isolates user scopes, retains records on auth clear, and broadcasts only explicit sign-out", async () => {
    seed("foreign", 3, "private", "bob");
    seed("closed", 1);
    sessionStorage.setItem(WORKSPACE_PAGE_ID_KEY, "foreign");
    const live = await open();
    expect(live.pageId).toBe("closed");
    seed("second", 2);
    const listener = new BroadcastChannel(WORKSPACE_TAB_CHANNEL);
    try {
      const message = new Promise((resolve) => listener.addEventListener("message", (event) => resolve(event.data), { once: true }));
      authSession.clear();
      expect(localStorage.getItem(key("closed"))).not.toBeNull();
      authSession.setAuthenticated(createMockAuthToken({ user_id: "alice" }), false);
      clearCurrentBrowserSession();
      expect(await message).toEqual({ type: "sign-out", userScope: "alice" });
      authSession.setAuthenticated(createMockAuthToken({ user_id: "alice" }), false);
      live.save(state, vi.fn());
      expect(localStorage.getItem(key("closed"))).toBeNull();
      expect(localStorage.getItem(key("second"))).toBeNull();
      expect(localStorage.getItem(key("foreign"))).not.toBeNull();
    } finally {
      listener.close();
    }
  });

  it("keeps more than 50 small closed workspaces when they fit the account's budget", async () => {
    const closedCount = 64;
    for (let index = 0; index <= closedCount; index += 1) seed(`small-${index}`, index);
    const owner = await open();
    expect(owner.pageId).toBe(`small-${closedCount}`);
    expect(localStorage.length).toBe(closedCount + 1);
  });

  it("prunes oldest closed workspaces until the account fits its budget, excluding live and foreign records", async () => {
    seed("live", 0, "x".repeat(CLOSED_WORKSPACE_TAB_BUDGET_BYTES / 2));
    sessionStorage.setItem(WORKSPACE_PAGE_ID_KEY, "live");
    await open();
    seed("foreign", 0, "x".repeat(CLOSED_WORKSPACE_TAB_BUDGET_BYTES / 2), "bob");
    seed("oldest", 1);
    seed("next-oldest", 2);
    const remaining = seed("recent", 3, "");
    const remainingLength = key("recent").length + JSON.stringify(remaining).length;
    remaining.left.tabs[0]!.path = "x".repeat(CLOSED_WORKSPACE_TAB_BUDGET_BYTES / 2 - remainingLength);
    localStorage.setItem(key("recent"), JSON.stringify(remaining));
    seed("claim", 4, "match");
    sessionStorage.clear();
    history.replaceState(null, "");

    expect((await open(route(target("match")))).pageId).toBe("claim");
    expect(localStorage.getItem(key("oldest"))).toBeNull();
    expect(localStorage.getItem(key("next-oldest"))).toBeNull();
    expect(localStorage.getItem(key("recent"))).not.toBeNull();
    expect(localStorage.getItem(key("live"))).not.toBeNull();
    expect(localStorage.getItem(key("foreign"))).not.toBeNull();
  });

  it("preserves the last saved workspace and closed workspaces when a save exceeds quota", async () => {
    seed("live", 0);
    seed("foreign", 0, "private", "bob");
    seed("oldest", 1);
    seed("recent", 2);
    sessionStorage.setItem(WORKSPACE_PAGE_ID_KEY, "live");
    const owner = await open();
    const getSavedRecords = () => ["live", "foreign", "oldest", "recent"].map((id) => localStorage.getItem(key(id)));
    const originalRecords = getSavedRecords();
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const notify = vi.fn();
    const next = { ...state, leftTabs: [tab("new")], leftSelectedTabId: "new" };
    owner.save(next, notify);
    expect(notify).toHaveBeenCalledWith(true);
    expect(owner.record?.left.selectedTabId).toBe("new");
    expect(getSavedRecords()).toEqual(originalRecords);

    setItem.mockRestore();
    notify.mockClear();
    owner.save(next, notify);
    expect(localStorage.getItem(key("live"))).toContain('"selectedTabId":"new"');
    expect(getSavedRecords().slice(1)).toEqual(originalRecords.slice(1));
    expect(notify).not.toHaveBeenCalled();
  });

  it("migrates schema 1 in its saved order and derives the same workspace route identity", async () => {
    const incoming = route(target("Reports"));
    const identity = getWorkspaceBrowseIdentity(incoming);
    const legacyTab = (id: string, path: string) => ({
      id,
      location: { target: target(path), connectionId: "smb-id", physicalPath: path, archiveLocation: null },
      sortBy: "name",
      sortDirection: "asc",
    });
    sessionStorage.setItem(
      LEGACY_PANE_TABS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        userScope: "alice",
        workspaceRouteIdentity: identity,
        paneMode: "single",
        activePaneId: "left",
        left: { orderedIds: ["a", "b"], selectedTabId: "b", tabs: [legacyTab("b", "Reports"), legacyTab("a", "")] },
        right: null,
      })
    );
    const claim = await open(incoming);
    expect(claim.record?.left.tabs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(getWorkspaceBrowseIdentity(getStoredWorkspaceRoute(claim.record!))).toBe(identity);
    expect(sessionStorage.getItem(LEGACY_PANE_TABS_KEY)).toBeNull();
    expect(localStorage.getItem(key(claim.pageId))).not.toContain("workspaceRouteIdentity");
  });

  it("keeps an over-budget workspace whose page cannot answer a channel liveness query", async () => {
    Object.defineProperty(navigator, "locks", { value: undefined });
    const frozenRecord = seed("frozen", 1, "x".repeat(CLOSED_WORKSPACE_TAB_BUDGET_BYTES / 2));
    sessionStorage.setItem(WORKSPACE_PAGE_ID_KEY, "frozen");
    const frozen = await open();
    seed("closed", 2, "match");
    sessionStorage.clear();
    history.replaceState(null, "");

    // Drop replies to model a page that cannot respond until it resumes.
    const { postMessage } = BroadcastChannel.prototype;
    const channelSend = vi.spyOn(BroadcastChannel.prototype, "postMessage").mockImplementation(function (this: BroadcastChannel, data) {
      if (data.type !== "liveness-reply") postMessage.call(this, data);
    });
    expect((await open(route(target("match")))).pageId).toBe("closed");
    expect(channelSend).toHaveBeenCalledWith(expect.objectContaining({ type: "liveness-reply", pageId: "frozen" }));
    expect(localStorage.getItem(key("frozen"))).toBe(JSON.stringify(frozenRecord));
    channelSend.mockRestore();

    frozen.save({ ...state, leftTabs: [tab("resumed")], leftSelectedTabId: "resumed" }, vi.fn());
    expect(localStorage.getItem(key("frozen"))).toContain('"selectedTabId":"resumed"');
  });

  it("uses channel liveness on plain HTTP and stops saving on a remote sign-out", async () => {
    Object.defineProperty(navigator, "locks", { value: undefined });
    const live = await open();
    live.save(state, vi.fn());
    sessionStorage.removeItem(WORKSPACE_PAGE_ID_KEY);
    history.replaceState(null, "");
    const newcomer = await open();
    expect(newcomer.pageId).not.toBe(live.pageId);
    expect(newcomer.record).toBeNull();
    const remote = new BroadcastChannel(WORKSPACE_TAB_CHANNEL);
    try {
      remote.postMessage({ type: "sign-out", userScope: "alice" });
      await vi.waitFor(() => expect(localStorage.getItem(key(live.pageId))).toBeNull());
      live.save(state, vi.fn());
      newcomer.save(state, vi.fn());
      expect(localStorage.length).toBe(0);
    } finally {
      remote.close();
    }
  });
});
