import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import "../../i18n";
import { authSession } from "../../services/authSession";
import { createMockAuthToken } from "../../test/fixtures/users";
import Login from "../Login";

vi.mock("../../services/api", () => ({ login: vi.fn() }));
vi.mock("../../services/authConfig", () => ({
  getAuthConfig: vi.fn().mockResolvedValue({
    sign_in_mode: "oidc_or_password",
    oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
  }),
}));

afterEach(() => {
  cleanup();
  authSession.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("recovers when a hidden tab becomes visible without a focus event or login broadcast", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.spyOn(authSession, "bootstrap").mockResolvedValue("idle");
  vi.spyOn(authSession, "hasUsableAccessToken").mockReturnValue(false);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const refresh = vi
    .spyOn(authSession, "requestRefresh")
    .mockResolvedValue(createMockAuthToken({ access_token: "restored-token", token_type: "bearer" }));
  sessionStorage.clear();
  window.location.search = "?return_path=%2Fbrowse%2Fsmb%2Fdemo";
  const router = createMemoryRouter(
    [
      { path: "/login", element: <Login /> },
      { path: "/browse/smb/demo", element: <output>Restored browser</output> },
    ],
    { initialEntries: [`/login${window.location.search}`] }
  );
  render(<RouterProvider router={router} />);
  await screen.findByLabelText(/username/i);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(refresh).not.toHaveBeenCalled();

  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

  expect(await screen.findByText("Restored browser")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/browse/smb/demo");
  expect(refresh).toHaveBeenCalledOnce();
});
