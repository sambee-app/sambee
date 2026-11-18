import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCurrentBrowserSession, signOutCurrentBrowser } from "../../../services/accountSession";
import { AuthSessionManager, authSession } from "../../../services/authSession";
import { logger } from "../../../services/logger";
import { createMockConnection } from "../../../test/fixtures/connections";
import { createMockAuthToken } from "../../../test/fixtures/users";
import {
  loadPaneTabsSessionStorage,
  PANE_TABS_SESSION_STORAGE_KEY,
  readPaneTabHistoryState,
  resetPaneTabsStorageStateForTesting,
  resolveRestoredWorkspaceTabs,
  savePaneTabsSessionStorage,
  withPaneTabHistoryState,
} from "../tabSessionStorage";

const connections = [
  createMockConnection({ id: "conn-1", slug: "demo", name: "Demo" }),
  createMockConnection({ id: "conn-2", slug: "backup", name: "Backup" }),
];

describe("tabSessionStorage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetPaneTabsStorageStateForTesting();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "token-1", user_id: "user-1" }), false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    resetPaneTabsStorageStateForTesting();
  });

  it("saves and restores matching workspace reloads while preserving hidden-pane tabs", () => {
    const saved = savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo/Test",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [
        { id: "l1", connectionId: "conn-1", currentPath: "", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
        { id: "l2", connectionId: "conn-1", currentPath: "Test", archiveLocation: null, sortBy: "size", sortDirection: "desc" },
      ],
      leftSelectedTabId: "l2",
      rightTabs: [
        { id: "r1", connectionId: "conn-2", currentPath: "Exports", archiveLocation: null, sortBy: "modified", sortDirection: "asc" },
      ],
      rightSelectedTabId: "r1",
      connections,
    });
    expect(saved).toEqual({ saved: true, notifyUnavailable: false });

    const loaded = loadPaneTabsSessionStorage();
    expect(loaded.record).not.toBeNull();

    const restored = resolveRestoredWorkspaceTabs(
      loaded.record!,
      {
        left: { kind: "smb", targetId: "demo", path: "Test" },
        right: null,
        activePaneId: "left",
      },
      connections
    );
    expect(restored.isMatchingReload).toBe(true);
    expect(restored.paneMode).toBe("single");
    expect(restored.left.orderedIds).toEqual(["l1", "l2"]);
    expect(restored.left.selectedTabId).toBe("l2");
    expect(restored.left.sessions.get("l2")?.sortBy).toBe("size");
    expect(restored.right?.orderedIds).toEqual(["r1"]);
    expect(restored.right?.sessions.get("r1")?.currentPath).toBe("Exports");
  });

  it("applies an explicit incoming link to the selected tab while retaining background tabs", () => {
    savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo/Test",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [
        { id: "l1", connectionId: "conn-1", currentPath: "Images", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
        { id: "l2", connectionId: "conn-1", currentPath: "Test", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
      ],
      leftSelectedTabId: "l2",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });

    const loaded = loadPaneTabsSessionStorage();
    const restored = resolveRestoredWorkspaceTabs(
      loaded.record!,
      {
        left: { kind: "smb", targetId: "backup", path: "Reports" },
        right: null,
        activePaneId: "left",
      },
      connections
    );

    expect(restored.isMatchingReload).toBe(false);
    expect(restored.left.orderedIds).toEqual(["l1", "l2"]);
    expect(restored.left.selectedTabId).toBe("l2");
    expect(restored.left.sessions.get("l1")?.currentPath).toBe("Images");
    expect(restored.left.sessions.get("l2")?.connectionId).toBe("conn-2");
    expect(restored.left.sessions.get("l2")?.currentPath).toBe("Reports");
  });

  it("clears saved tabs on sign-out and rejects records belonging to a different user", async () => {
    savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [{ id: "l1", connectionId: "conn-1", currentPath: "Secret", archiveLocation: null, sortBy: "name", sortDirection: "asc" }],
      leftSelectedTabId: "l1",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeTruthy();

    // Switching user identity without signOut must also reject the prior user's record
    authSession.setAuthenticated(createMockAuthToken({ access_token: "token-2", user_id: "user-2" }), false);
    expect(loadPaneTabsSessionStorage().record).toBeNull();
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeNull();

    // Sign out explicitly clears session storage
    vi.spyOn(authSession, "logout").mockResolvedValue(undefined);
    savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [{ id: "l1", connectionId: "conn-1", currentPath: "", archiveLocation: null, sortBy: "name", sortDirection: "asc" }],
      leftSelectedTabId: "l1",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });
    await signOutCurrentBrowser();
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeNull();

    savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [{ id: "l1", connectionId: "conn-1", currentPath: "", archiveLocation: null, sortBy: "name", sortDirection: "asc" }],
      leftSelectedTabId: "l1",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });
    clearCurrentBrowserSession();
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("logs and discards malformed or unsupported-version storage records", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    sessionStorage.setItem(PANE_TABS_SESSION_STORAGE_KEY, "{not-valid-json");
    expect(loadPaneTabsSessionStorage()).toEqual({ record: null, notifyUnavailable: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    sessionStorage.setItem(PANE_TABS_SESSION_STORAGE_KEY, JSON.stringify({ schemaVersion: 999 }));
    expect(loadPaneTabsSessionStorage()).toEqual({ record: null, notifyUnavailable: false });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("reports unavailable sessionStorage once without repeating notices on subsequent writes", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });

    const first = savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [{ id: "l1", connectionId: "conn-1", currentPath: "", archiveLocation: null, sortBy: "name", sortDirection: "asc" }],
      leftSelectedTabId: "l1",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });
    const second = savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [{ id: "l1", connectionId: "conn-1", currentPath: "", archiveLocation: null, sortBy: "name", sortDirection: "asc" }],
      leftSelectedTabId: "l1",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });

    expect(first).toEqual({ saved: false, notifyUnavailable: true });
    expect(second).toEqual({ saved: false, notifyUnavailable: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated router history state when attaching pane tab IDs", () => {
    const merged = withPaneTabHistoryState({ customFlag: 42 }, { leftTabId: "l1", rightTabId: "r2" });
    expect(merged["customFlag"]).toBe(42);
    expect(readPaneTabHistoryState(merged)).toEqual({ leftTabId: "l1", rightTabId: "r2" });
    expect(readPaneTabHistoryState(null)).toBeNull();
  });

  it("preserves anonymous tabs across startup refresh 401 while clearing account-owned records and honoring explicit cleanup", async () => {
    // 1. Anonymous mode (userScope === null): save 3 tabs
    authSession.clear();
    expect(authSession.getUserId()).toBeNull();

    savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo/Images",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [
        { id: "anon-1", connectionId: "conn-1", currentPath: "", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
        { id: "anon-2", connectionId: "conn-1", currentPath: "Test", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
        { id: "anon-3", connectionId: "conn-1", currentPath: "Images", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
      ],
      leftSelectedTabId: "anon-3",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });

    // Simulate reload startup where POST /auth/oidc/refresh returns 401 and triggers authSession.clear() before workspace mounts
    const refreshClient = (authSession as unknown as { refreshClient: { post: ReturnType<typeof vi.fn> } }).refreshClient;
    vi.spyOn(refreshClient, "post").mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401, data: {} },
    });
    await expect(authSession.requestRefresh()).rejects.toThrow();

    // Anonymous record survives the startup 401 clear and restores all 3 tabs!
    const loadedAnon = loadPaneTabsSessionStorage();
    expect(loadedAnon.record?.userScope).toBeNull();
    expect(loadedAnon.record?.left.orderedIds).toEqual(["anon-1", "anon-2", "anon-3"]);

    // Account transition (anonymous -> authenticated user-1) rejects and removes the anonymous record
    authSession.setAuthenticated(createMockAuthToken({ access_token: "token-1", user_id: "user-1" }), false);
    expect(loadPaneTabsSessionStorage().record).toBeNull();
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeNull();

    // 2. Account-owned record (userScope === "user-1") IS cleared immediately when authSession clears on 401
    savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [{ id: "u1", connectionId: "conn-1", currentPath: "Private", archiveLocation: null, sortBy: "name", sortDirection: "asc" }],
      leftSelectedTabId: "u1",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });
    vi.spyOn(refreshClient, "post").mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401, data: {} },
    });
    await expect(authSession.requestRefresh()).rejects.toThrow();
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeNull();

    // 3. Explicit session reset / sign-out still clears anonymous records too
    expect(authSession.getUserId()).toBeNull();
    savePaneTabsSessionStorage({
      workspaceRouteIdentity: "/browse/smb/demo",
      paneMode: "single",
      activePaneId: "left",
      leftTabs: [{ id: "anon-only", connectionId: "conn-1", currentPath: "", archiveLocation: null, sortBy: "name", sortDirection: "asc" }],
      leftSelectedTabId: "anon-only",
      rightTabs: [],
      rightSelectedTabId: "",
      connections,
    });
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeTruthy();
    clearCurrentBrowserSession();
    expect(sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY)).toBeNull();
    void AuthSessionManager;
  });

  it("handles unavailable sessionStorage during auth clear without suppressing the workspace UI notice", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });

    // Startup authSession.clear() runs before BrowserWorkspace mounts
    expect(() => authSession.clear()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Subsequent loadPaneTabsSessionStorage() in BrowserWorkspace still surfaces notifyUnavailable once
    expect(loadPaneTabsSessionStorage()).toEqual({ record: null, notifyUnavailable: true });
    expect(loadPaneTabsSessionStorage()).toEqual({ record: null, notifyUnavailable: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
