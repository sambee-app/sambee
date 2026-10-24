import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockAuthToken } from "../../test/fixtures/users";
import { server } from "../../test/mocks/server";
import { type AuthSessionError, AuthSessionManager } from "../authSession";

const OIDC_REFRESH_URL = "http://localhost:3000/api/auth/oidc/refresh";

describe("AuthSessionManager", () => {
  let session: AuthSessionManager | null = null;

  afterEach(() => {
    session?.clear();
    session = null;
    vi.unstubAllGlobals();
  });

  it("preserves a usable session when the OIDC refresh result is uncertain", async () => {
    server.use(
      http.post(OIDC_REFRESH_URL, ({ request }) => {
        expect(request.headers.get("X-Sambee-OIDC-Refresh-Generation")).toBe("7");
        return HttpResponse.json({ detail: { code: "oidc_refresh_uncertain" } }, { status: 401 });
      })
    );
    session = new AuthSessionManager();
    session.setAuthenticated(
      createMockAuthToken({
        access_token: "still-usable-token",
        token_type: "bearer",
        access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
        oidc_refresh_generation: 7,
      }),
      true
    );

    await expect(session.requestRefresh()).rejects.toMatchObject<Partial<AuthSessionError>>({ code: "refresh-uncertain" });

    expect(session.getState()).toBe("refresh-uncertain");
    expect(session.getAccessToken()).toBe("still-usable-token");
    expect(session.hasUsableAccessToken()).toBe(true);
  });

  it("requires controlled reauthorization at a no-refresh absolute deadline", async () => {
    const deadline = Date.now() + 10_000;
    session = new AuthSessionManager();
    const redirect = vi.fn();
    session.setReauthenticationHandler(redirect);
    session.setAuthenticated(
      createMockAuthToken({
        access_token: "no-refresh-token",
        token_type: "bearer",
        user_id: "user-1",
        oidc_session_capability: "reauthorization_only",
        oidc_session_expires_at: new Date(deadline).toISOString(),
        access_token_expires_at: new Date(deadline).toISOString(),
      }),
      true
    );
    expect(session.hasUsableAccessToken()).toBe(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
    try {
      await expect(session.refreshIfNeeded()).rejects.toMatchObject<Partial<AuthSessionError>>({ code: "reauthentication-required" });
      expect(session.hasUsableAccessToken()).toBe(false);
      expect(redirect).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it("verifies a new login cookie despite an expired deadline from the previous session", async () => {
    const deadline = Date.now() + 10_000;
    let refreshRequests = 0;
    server.use(
      http.post(OIDC_REFRESH_URL, () => {
        refreshRequests += 1;
        return HttpResponse.json({ access_token: "new-session", token_type: "bearer", user_id: "user-2" });
      })
    );
    session = new AuthSessionManager();
    session.setAuthenticated(
      createMockAuthToken({
        access_token: "old-session",
        token_type: "bearer",
        user_id: "user-1",
        oidc_session_expires_at: new Date(deadline).toISOString(),
        access_token_expires_at: new Date(deadline).toISOString(),
      }),
      true
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
    try {
      await expect(session.requestRefresh({ newLogin: true })).resolves.toMatchObject({ access_token: "new-session" });
      expect(refreshRequests).toBe(1);
      expect(session.getUserId()).toBe("user-2");
    } finally {
      clock.mockRestore();
    }
  });

  it("does not reuse or apply an in-flight refresh from before the new login", async () => {
    let releaseOldRefresh!: () => void;
    const oldRefreshWait = new Promise<void>((resolve) => {
      releaseOldRefresh = resolve;
    });
    let refreshRequests = 0;
    server.use(
      http.post(OIDC_REFRESH_URL, async () => {
        refreshRequests += 1;
        if (refreshRequests === 1) {
          await oldRefreshWait;
          return HttpResponse.json({ access_token: "old-session", token_type: "bearer", user_id: "user-1" });
        }
        return HttpResponse.json({ access_token: "new-session", token_type: "bearer", user_id: "user-2" });
      })
    );
    session = new AuthSessionManager();
    session.setAuthenticated(createMockAuthToken({ access_token: "expired-session", token_type: "bearer", user_id: "user-1" }), true);
    const oldRefresh = session.requestRefresh();
    const oldFailure = expect(oldRefresh).rejects.toThrow();
    await vi.waitFor(() => expect(refreshRequests).toBe(1));

    await expect(session.requestRefresh({ newLogin: true })).resolves.toMatchObject({ access_token: "new-session" });
    releaseOldRefresh();
    await oldFailure;
    expect(refreshRequests).toBe(2);
    expect(session.getAccessToken()).toBe("new-session");
    expect(session.getUserId()).toBe("user-2");
  });

  it("restores a no-refresh session from its cookie after a page reload", async () => {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    let refreshRequests = 0;
    server.use(
      http.post(OIDC_REFRESH_URL, () => {
        refreshRequests += 1;
        return HttpResponse.json({
          access_token: "restored-token",
          token_type: "bearer",
          user_id: "user-1",
          oidc_session_capability: "reauthorization_only",
          oidc_session_expires_at: deadline,
          access_token_expires_at: deadline,
        });
      })
    );
    session = new AuthSessionManager();
    const redirect = vi.fn();
    session.setReauthenticationHandler(redirect);

    await expect(session.bootstrap()).resolves.toBe("active");

    expect(session.getAccessToken()).toBe("restored-token");
    expect(session.isBootstrapComplete()).toBe(true);
    expect(refreshRequests).toBe(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("publishes identity epochs for login and clear, but not same-user token refresh", () => {
    session = new AuthSessionManager();
    const identities: Array<{ epoch: number; userId: string | null }> = [];
    session.subscribeToIdentity((identity) => identities.push(identity));

    session.setAuthenticated(createMockAuthToken({ access_token: "first-token", token_type: "bearer", user_id: "user-1" }), true);
    session.setAuthenticated(createMockAuthToken({ access_token: "refreshed-token", token_type: "bearer", user_id: "user-1" }), true);
    session.clear();
    session.setAuthenticated(createMockAuthToken({ access_token: "second-token", token_type: "bearer", user_id: "user-1" }), true);

    expect(identities).toEqual([
      { epoch: 1, userId: "user-1" },
      { epoch: 2, userId: null },
      { epoch: 3, userId: "user-1" },
    ]);
  });

  it.each(["success", "failure"])("keeps a new login when an older bootstrap refresh finishes with %s", async (outcome) => {
    let finishRefresh!: () => void;
    const refreshWait = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    server.use(
      http.post(OIDC_REFRESH_URL, async () => {
        await refreshWait;
        return outcome === "success"
          ? HttpResponse.json({ access_token: "old-session", token_type: "bearer", user_id: "same-user" })
          : HttpResponse.json({ detail: { code: "oidc_reauthentication_required" } }, { status: 401 });
      })
    );
    session = new AuthSessionManager();
    const identities: number[] = [];
    session.subscribeToIdentity(({ epoch }) => identities.push(epoch));
    const bootstrap = session.bootstrap();
    await vi.waitFor(() => expect(session?.getState()).toBe("refreshing"));
    session.setAuthenticated(createMockAuthToken({ access_token: "new-session", token_type: "bearer", user_id: "same-user" }), true);
    session.completeLoginBootstrap();
    finishRefresh();
    await bootstrap;

    expect(session.getAccessToken()).toBe("new-session");
    expect(session.getState()).toBe("active");
    expect(session.isBootstrapComplete()).toBe(true);
    expect(identities).toEqual([1]);
  });

  it.each(["success", "failure"])("does not share an older %s refresh with a new login", async (outcome) => {
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldWait = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const newWait = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    let requests = 0;
    server.use(
      http.post(OIDC_REFRESH_URL, async () => {
        requests += 1;
        if (requests === 1) {
          await oldWait;
          return outcome === "success"
            ? HttpResponse.json({ access_token: "old-refresh", token_type: "bearer", user_id: "same-user" })
            : HttpResponse.json({ detail: { code: "oidc_reauthentication_required" } }, { status: 401 });
        }
        await newWait;
        return HttpResponse.json({ access_token: "new-refresh", token_type: "bearer", user_id: "same-user" });
      })
    );
    session = new AuthSessionManager();
    session.setAuthenticated(createMockAuthToken({ access_token: "session-a", token_type: "bearer", user_id: "same-user" }), true);
    const oldRefresh = session.requestRefresh();
    const oldFailure = expect(oldRefresh).rejects.toThrow();
    await vi.waitFor(() => expect(requests).toBe(1));

    session.beginNewLogin();
    session.setAuthenticated(createMockAuthToken({ access_token: "session-b", token_type: "bearer", user_id: "same-user" }), true);
    const newRefresh = session.requestRefresh();
    await vi.waitFor(() => expect(requests).toBe(2));
    releaseOld();
    await oldFailure;
    const joinedRefresh = session.requestRefresh();
    expect(requests).toBe(2);
    releaseNew();

    await expect(newRefresh).resolves.toMatchObject({ access_token: "new-refresh" });
    await expect(joinedRefresh).resolves.toMatchObject({ access_token: "new-refresh" });
    expect(requests).toBe(2);
    expect(session.getAccessToken()).toBe("new-refresh");
    expect(session.getState()).toBe("active");
  });

  it("does not dispatch a queued refresh after a new login", async () => {
    let releaseLock!: () => void;
    const lockWait = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
          await lockWait;
          return callback();
        },
      },
    });
    let requests = 0;
    server.use(
      http.post(OIDC_REFRESH_URL, () => {
        requests += 1;
        return HttpResponse.json({ access_token: "old-refresh", token_type: "bearer" });
      })
    );
    session = new AuthSessionManager();
    session.setAuthenticated(createMockAuthToken({ access_token: "session-a", token_type: "bearer" }), true);
    const oldRefresh = session.requestRefresh();
    const oldFailure = expect(oldRefresh).rejects.toThrow();
    session.beginNewLogin();
    session.setAuthenticated(createMockAuthToken({ access_token: "session-b", token_type: "bearer" }), true);
    releaseLock();

    await oldFailure;
    expect(requests).toBe(0);
    expect(session.getAccessToken()).toBe("session-b");
    expect(session.getState()).toBe("active");
  });
});
