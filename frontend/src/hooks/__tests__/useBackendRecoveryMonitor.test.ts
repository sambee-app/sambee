import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setOidcExchangePending } from "../../services/api";
import { AuthSessionError, authSession } from "../../services/authSession";
import {
  type BackendAvailabilityStatus,
  getBackendAvailabilitySnapshot,
  resetBackendAvailabilityForTests,
} from "../../services/backendAvailability";
import { createMockAuthToken } from "../../test/fixtures/users";
import { useBackendRecoveryMonitor } from "../useBackendRecoveryMonitor";

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useBackendRecoveryMonitor", () => {
  beforeEach(() => {
    resetBackendAvailabilityForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    setOidcExchangePending(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps probing until the backend recovers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const onRecovered = vi.fn();
    const onReconnectNow = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(
      ({ status }: { status: BackendAvailabilityStatus }) => useBackendRecoveryMonitor({ status, onRecovered, onReconnectNow }),
      {
        initialProps: { status: "available" as const },
      }
    );

    rerender({ status: "unavailable" });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getBackendAvailabilitySnapshot().status).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getBackendAvailabilitySnapshot().status).toBe("available");
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onReconnectNow).toHaveBeenCalled();
  });

  it("triggers an immediate recovery probe on focus", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const onReconnectNow = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(
      ({ status }: { status: BackendAvailabilityStatus }) => useBackendRecoveryMonitor({ status, onReconnectNow }),
      {
        initialProps: { status: "available" as const },
      }
    );

    rerender({ status: "unavailable" });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onReconnectNow).toHaveBeenCalledWith("window-focus");
  });

  it("proactively probes on focus after resume even when backend still looks available", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(() =>
      useBackendRecoveryMonitor({ status: "available" })
    );

    expect(fetchMock).toHaveBeenCalledTimes(0);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles proactive focus probes while backend remains available", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(() =>
      useBackendRecoveryMonitor({ status: "available" })
    );

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not proactively probe on a normal pageshow during hard reload", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(() =>
      useBackendRecoveryMonitor({ status: "available" })
    );

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("proactively probes on a persisted pageshow restore", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(() =>
      useBackendRecoveryMonitor({ status: "available" })
    );

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses an authenticated recovery probe when an access token is present", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    authSession.setAuthenticated(createMockAuthToken({ access_token: "token-123", token_type: "bearer" }), false);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(
      ({ status }: { status: BackendAvailabilityStatus }) => useBackendRecoveryMonitor({ status }),
      {
        initialProps: { status: "available" as const },
      }
    );

    rerender({ status: "unavailable" });

    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/auth/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
        }),
      })
    );
  });

  it("refreshes an expired authenticated probe and retries immediately", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const refreshMock = vi
      .spyOn(authSession, "requestRefresh")
      .mockResolvedValue(createMockAuthToken({ access_token: "renewed-token", token_type: "bearer" }));
    const onReconnectNow = vi.fn();

    authSession.setAuthenticated(createMockAuthToken({ access_token: "expired-token", token_type: "bearer" }), false);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(
      ({ status }: { status: BackendAvailabilityStatus }) => useBackendRecoveryMonitor({ status, onReconnectNow }),
      {
        initialProps: { status: "available" as const },
      }
    );

    rerender({ status: "unavailable" });
    await flushAsyncWork();

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(getBackendAvailabilitySnapshot().status).toBe("available");
    onReconnectNow.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getBackendAvailabilitySnapshot().status).toBe("available");
    expect(onReconnectNow).toHaveBeenCalledWith("health-probe-success");
  });

  it("ignores a late 401 from a probe sent with a superseded token", async () => {
    let finishProbe!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(
      new Promise((resolve) => {
        finishProbe = resolve;
      })
    );
    const refresh = vi.spyOn(authSession, "requestRefresh");
    const onAuthenticationFailure = vi.fn();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "session-a", token_type: "bearer" }), false);
    vi.stubGlobal("fetch", fetchMock);

    renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(() =>
      useBackendRecoveryMonitor({ status: "available", onAuthenticationFailure })
    );
    act(() => window.dispatchEvent(new Event("focus")));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer session-a" }) })
    );
    authSession.setAuthenticated(createMockAuthToken({ access_token: "session-b", token_type: "bearer" }), false);
    await act(async () => {
      finishProbe(new Response(null, { status: 401 }));
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(onAuthenticationFailure).not.toHaveBeenCalled();
    expect(getBackendAvailabilitySnapshot().status).toBe("available");
    expect(authSession.getAccessToken()).toBe("session-b");
    refresh.mockRestore();
    authSession.clear();
  });

  it("keeps a failed callback in control when its protected probe returns 401 afterward", async () => {
    let finishProbe!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockReturnValue(
        new Promise((resolve) => {
          finishProbe = resolve;
        })
      )
    );
    const refresh = vi.spyOn(authSession, "requestRefresh");
    const onAuthenticationFailure = vi.fn();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "session-a", token_type: "bearer" }), false);
    setOidcExchangePending(true);
    renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(() =>
      useBackendRecoveryMonitor({ status: "available", onAuthenticationFailure })
    );
    act(() => window.dispatchEvent(new Event("focus")));
    setOidcExchangePending(false);
    await act(async () => {
      finishProbe(new Response(null, { status: 401 }));
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(onAuthenticationFailure).not.toHaveBeenCalled();
    expect(getBackendAvailabilitySnapshot().status).toBe("available");
    refresh.mockRestore();
    authSession.clear();
  });

  it("ignores a failed A refresh when B arrives during the recovery probe", async () => {
    let failRefresh!: (error: Error) => void;
    const refresh = vi.spyOn(authSession, "requestRefresh").mockReturnValue(
      new Promise((_, reject) => {
        failRefresh = reject;
      })
    );
    const onAuthenticationFailure = vi.fn();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "session-a", token_type: "bearer" }), false);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })));
    renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(() =>
      useBackendRecoveryMonitor({ status: "available", onAuthenticationFailure })
    );
    act(() => window.dispatchEvent(new Event("focus")));
    await flushAsyncWork();
    expect(refresh).toHaveBeenCalledTimes(1);
    authSession.setAuthenticated(createMockAuthToken({ access_token: "session-b", token_type: "bearer" }), false);
    await act(async () => {
      failRefresh(new AuthSessionError("reauthentication-required", "A expired"));
    });

    expect(onAuthenticationFailure).not.toHaveBeenCalled();
    expect(authSession.getAccessToken()).toBe("session-b");
    refresh.mockRestore();
    authSession.clear();
  });

  it("keeps retrying when an OIDC refresh result is uncertain but the access token is usable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const onAuthenticationFailure = vi.fn();

    vi.spyOn(authSession, "requestRefresh").mockRejectedValue(new AuthSessionError("refresh-uncertain", "Refresh result is uncertain."));
    authSession.setAuthenticated(
      createMockAuthToken({
        access_token: "still-usable-token",
        token_type: "bearer",
        access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      true
    );
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(
      ({ status }: { status: BackendAvailabilityStatus }) => useBackendRecoveryMonitor({ status, onAuthenticationFailure }),
      {
        initialProps: { status: "available" as const },
      }
    );

    rerender({ status: "unavailable" });
    await flushAsyncWork();

    expect(onAuthenticationFailure).not.toHaveBeenCalled();
    expect(getBackendAvailabilitySnapshot().status).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onAuthenticationFailure).not.toHaveBeenCalled();
  });

  it("requests controlled reauthentication when a recovery token refresh fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const onAuthenticationFailure = vi.fn();

    vi.spyOn(authSession, "requestRefresh").mockRejectedValue(new AuthSessionError("reauthentication-required", "Sign-in required."));
    authSession.setAuthenticated(createMockAuthToken({ access_token: "expired-token", token_type: "bearer" }), false);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(
      ({ status }: { status: BackendAvailabilityStatus }) => useBackendRecoveryMonitor({ status, onAuthenticationFailure }),
      {
        initialProps: { status: "available" as const },
      }
    );

    rerender({ status: "unavailable" });
    await flushAsyncWork();

    expect(onAuthenticationFailure).toHaveBeenCalledTimes(1);
    expect(getBackendAvailabilitySnapshot().status).toBe("available");
  });

  it("escalates to unavailable after repeated failed probes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook<ReturnType<typeof useBackendRecoveryMonitor>, { status: BackendAvailabilityStatus }>(
      ({ status }: { status: BackendAvailabilityStatus }) => useBackendRecoveryMonitor({ status }),
      {
        initialProps: { status: "available" as const },
      }
    );

    rerender({ status: "reconnecting" });

    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getBackendAvailabilitySnapshot().status).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(getBackendAvailabilitySnapshot().status).toBe("unavailable");
  });
});
