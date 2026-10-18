import { act, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { type ReactNode, StrictMode, useEffect, useState } from "react";
import { createMemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../test/mocks/server";
import { SambeeThemeProvider, useSambeeTheme } from "../../theme";
import OidcCallback from "../OidcCallback";

let testRouter: ReturnType<typeof createMemoryRouter>;
function MemoryRouter({ initialEntries = ["/login/oidc/callback"], children }: { initialEntries?: string[]; children: ReactNode }) {
  const [router] = useState(() =>
    createMemoryRouter([{ path: "*", element: children }], {
      initialEntries: initialEntries.map((entry) => `${entry}${window.location.hash ? `#${window.location.hash.replace(/^#/, "")}` : ""}`),
    })
  );
  testRouter = router;
  return <RouterProvider router={router} />;
}

vi.mock("../../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api")>();
  return { ...actual, exchangeOidcGrant: vi.fn(), setOidcExchangePending: vi.fn(actual.setOidcExchangePending) };
});

import api, { exchangeOidcGrant, setOidcExchangePending } from "../../services/api";
import { authSession } from "../../services/authSession";
import { logger } from "../../services/logger";
import { loginPath, loginReturnPath, OIDC_LOGIN_CHANNEL, sanitizeReturnPath } from "../../services/oidcAuth";
import { getConfirmedCurrentUserSetting, resetCurrentUserSettingsStoreForTests } from "../../services/userSettingsStore";

describe("OIDC callback", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    authSession.clear();
    resetCurrentUserSettingsStoreForTests();
    setOidcExchangePending(false);
    vi.mocked(window.location.assign).mockClear();
    vi.spyOn(logger, "initializeBackendTracing").mockResolvedValue(undefined);
    vi.mocked(exchangeOidcGrant).mockReset();
    window.history.replaceState(null, "", "/login/oidc/callback");
    window.location.hash = "";
    window.location.hash = "grant=one-time-grant";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setOidcExchangePending(false);
  });

  it.each(["renewable", "reauthorization_only"] as const)(
    "clears the fragment before exchanging a %s session grant",
    async (capability) => {
      const postMessage = vi.fn();
      const close = vi.fn();
      const openChannel = vi.fn();
      vi.stubGlobal(
        "BroadcastChannel",
        class {
          constructor(name: string) {
            openChannel(name);
          }
          postMessage = postMessage;
          close = close;
        }
      );
      expect(window.location.hash).toContain("grant=one-time-grant");
      let fragmentScrubbedBeforeExchange = false;
      vi.mocked(exchangeOidcGrant).mockImplementation(async () => {
        fragmentScrubbedBeforeExchange = !testRouter.state.location.hash.includes("grant");
        return {
          access_token: "sambee-token",
          token_type: "bearer",
          user_id: "alice",
          username: "alice",
          oidc_session_capability: capability,
          oidc_session_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          access_token_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          return_path: "/browse",
        };
      });

      render(
        <StrictMode>
          <MemoryRouter initialEntries={["/login/oidc/callback"]}>
            <Routes>
              <Route path="/login/oidc/callback" element={<OidcCallback />} />
              <Route path="/browse" element={<div>File browser</div>} />
            </Routes>
          </MemoryRouter>
        </StrictMode>
      );

      await waitFor(() => expect(exchangeOidcGrant).toHaveBeenCalledWith("one-time-grant"));
      expect(fragmentScrubbedBeforeExchange).toBe(true);
      expect(await screen.findByText("File browser")).toBeInTheDocument();
      expect(authSession.getAccessToken()).toBe("sambee-token");
      expect(authSession.isBootstrapComplete()).toBe(true);
      expect(exchangeOidcGrant).toHaveBeenCalledTimes(1);
      expect(openChannel).toHaveBeenCalledWith(OIDC_LOGIN_CHANNEL);
      expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "completed" });
      expect(close).toHaveBeenCalledOnce();
      expect(screen.queryByLabelText("Completing sign in")).not.toBeInTheDocument();
    }
  );

  it("shows a generic retry action when the grant is missing", async () => {
    window.history.replaceState(null, "", "/login/oidc/callback");
    window.location.hash = "";

    render(
      <MemoryRouter initialEntries={["/login/oidc/callback"]}>
        <OidcCallback />
      </MemoryRouter>
    );

    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(exchangeOidcGrant).not.toHaveBeenCalled();
    expect(setOidcExchangePending).toHaveBeenCalledWith(false);
  });

  it("completes sign-in even when a browser cannot open the login channel", async () => {
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new Error("Channel unavailable");
        }
      }
    );
    vi.mocked(exchangeOidcGrant).mockResolvedValue({ access_token: "sambee-token", token_type: "bearer", return_path: "/browse" });

    render(
      <MemoryRouter initialEntries={["/login/oidc/callback"]}>
        <Routes>
          <Route path="/login/oidc/callback" element={<OidcCallback />} />
          <Route path="/browse" element={<div>File browser</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("File browser")).toBeInTheDocument();
    expect(authSession.getAccessToken()).toBe("sambee-token");
  });

  it("keeps the callback error visible when exchange fails", async () => {
    const postMessage = vi.fn();
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        postMessage = postMessage;
        close() {}
      }
    );
    let rejectExchange!: (reason: Error) => void;
    vi.mocked(exchangeOidcGrant).mockReturnValue(
      new Promise((_, reject) => {
        rejectExchange = reject;
      })
    );
    render(
      <MemoryRouter>
        <OidcCallback />
      </MemoryRouter>
    );
    await waitFor(() => expect(setOidcExchangePending).toHaveBeenCalledWith(true));
    rejectExchange(new Error("Grant expired"));
    expect(await screen.findByText("Sign in could not be completed.")).toBeInTheDocument();
    expect(setOidcExchangePending).toHaveBeenLastCalledWith(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("finishes the same-user callback despite late 401s from A and loads protected data with B", async () => {
    const sessionA = { access_token: "session-a", token_type: "bearer", user_id: "same-user" };
    const sessionB = {
      access_token: "session-b",
      token_type: "bearer",
      user_id: "same-user",
      oidc_session_capability: "reauthorization_only",
      oidc_session_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      access_token_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      return_path: "/login/oidc/callback",
    };
    const refresh = vi.spyOn(authSession, "requestRefresh").mockImplementation(async () => {
      authSession.setAuthenticated(sessionA, true);
      return sessionA;
    });
    await authSession.bootstrap();
    refresh.mockRestore();

    let releaseOldRequests!: () => void;
    let releaseGrant!: () => void;
    const oldRequests = new Promise<void>((resolve) => {
      releaseOldRequests = resolve;
    });
    const grantExchange = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    const oldCalls = new Set<string>();
    const newCalls: string[] = [];
    const endpoint = (path: string, response: object) =>
      http.get(`http://localhost:3000/api${path}`, async ({ request }) => {
        const token = request.headers.get("Authorization");
        if (token === "Bearer session-a") {
          oldCalls.add(path);
          await oldRequests;
          return HttpResponse.json({ detail: { code: "oidc_reauthentication_required" } }, { status: 401 });
        }
        if (token === "Bearer session-b") {
          newCalls.push(path);
          return HttpResponse.json(response);
        }
        return HttpResponse.json({}, { status: 401 });
      });
    server.use(
      endpoint("/themes", { themes: [], site_default_id: "sambee-dark" }),
      endpoint("/auth/me", { id: "same-user", username: "alice", role: "admin" }),
      endpoint("/auth/me/settings", { appearance: { theme_id: "sambee-dark", custom_themes: [] } }),
      http.post("http://localhost:3000/api/auth/oidc/exchange", async () => {
        await grantExchange;
        return HttpResponse.json(sessionB);
      })
    );
    vi.mocked(exchangeOidcGrant).mockImplementation((grant) => api.exchangeOidcGrant(grant));

    function Browse() {
      const { currentTheme, isAdmin } = useSambeeTheme();
      const [protectedUser, setProtectedUser] = useState("");
      useEffect(() => {
        void api.getCurrentUser().then((user) => setProtectedUser(user.username));
      }, []);
      return (
        <div>
          Browse {protectedUser} {currentTheme.id} {isAdmin ? "admin" : "user"}
        </div>
      );
    }

    render(
      <SambeeThemeProvider>
        <MemoryRouter initialEntries={["/login/oidc/callback"]}>
          <Routes>
            <Route path="/login/oidc/callback" element={<OidcCallback />} />
            <Route path="/browse" element={<Browse />} />
          </Routes>
        </MemoryRouter>
      </SambeeThemeProvider>
    );
    await waitFor(() => {
      expect(oldCalls.has("/themes")).toBe(true);
      expect(oldCalls.has("/auth/me")).toBe(true);
    });
    await act(async () => {
      releaseGrant();
    });
    expect(await screen.findByText("Browse alice sambee-dark admin")).toBeInTheDocument();
    await act(async () => {
      releaseOldRequests();
    });
    await waitFor(() => expect(newCalls).toEqual(expect.arrayContaining(["/themes", "/auth/me", "/auth/me/settings"])));
    await waitFor(() => expect(getConfirmedCurrentUserSetting("appearance.theme_id")).toBe("sambee-dark"));
    expect(newCalls.filter((path) => path === "/themes")).toHaveLength(1);
    expect(authSession.getAccessToken()).toBe("session-b");
    expect(authSession.isBootstrapComplete()).toBe(true);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it.each([
    "/login/oidc/callback",
    "/login/oidc/callback?grant=expired",
    "https://outside.example/path",
    "//outside.example/path",
    "/\\outside.example/path",
  ])("rejects an unsafe return path: %s", (path) => {
    expect(sanitizeReturnPath(path)).toBe("/browse");
    expect(loginReturnPath(`?return_path=${encodeURIComponent(path)}`)).toBe("/browse");
    expect(loginPath(path)).toBe("/login?return_path=%2Fbrowse");
  });

  it("preserves internal return paths and queries", () => {
    expect(sanitizeReturnPath("/browse/folder?view=grid")).toBe("/browse/folder?view=grid");
    expect(loginReturnPath("?return_path=%2Flogin%2Foidc%2Fcallback")).toBe("/browse");
  });
});
