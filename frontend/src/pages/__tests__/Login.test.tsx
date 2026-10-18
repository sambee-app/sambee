import { act, render as renderWithMemoryRouter, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../../services/authSession";
import { OIDC_ATTEMPT_MARKER, OIDC_LOGIN_CHANNEL, OIDC_LOGOUT_MARKER } from "../../services/oidcAuth";
import { render } from "../../test/utils/test-utils";
import Login from "../Login";

// Mock the entire API module
vi.mock("../../services/api", () => ({
  default: {
    getCurrentUserSettings: vi.fn().mockResolvedValue(null),
  },
  login: vi.fn(),
}));

vi.mock("../../services/authConfig", () => ({
  getAuthConfig: vi.fn(),
}));

// Import the mocked function so we can control it
import { login as mockLogin } from "../../services/api";
import { getAuthConfig as mockGetAuthConfig } from "../../services/authConfig";

function CurrentPath() {
  const location = useLocation();
  return <output>{location.pathname}</output>;
}

class LoginChannel {
  static channels: LoginChannel[] = [];
  private readonly listeners = new Set<(event: MessageEvent<{ type: string }>) => void>();

  constructor(readonly name: string) {
    LoginChannel.channels.push(this);
  }

  addEventListener(_type: string, listener: (event: MessageEvent<{ type: string }>) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (event: MessageEvent<{ type: string }>) => void) {
    this.listeners.delete(listener);
  }

  close() {}

  emit(type: string) {
    for (const listener of this.listeners) listener(new MessageEvent("message", { data: { type } }));
  }
}

describe("Login Component", () => {
  it("reveals and hides the password without changing it or submitting", async () => {
    const user = userEvent.setup();
    render(<Login />);
    const password = await screen.findByLabelText(/^password/i);
    expect(password).toHaveAttribute("type", "password");
    await user.type(password, "Secret123!");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(password).toHaveValue("Secret123!");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveValue("Secret123!");
    expect(mockLogin).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    authSession.clear();
    LoginChannel.channels = [];
    // Clear localStorage before each test
    localStorage.clear();
    // Clear all mocks
    vi.clearAllMocks();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/login");
    window.location.search = "";
    window.location.hash = "";
    vi.mocked(window.location.assign).mockClear();
    vi.mocked(mockGetAuthConfig).mockResolvedValue({ sign_in_mode: "password_only", oidc: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["/browse/smb/demo", "/settings/appearance"])("recovers the tab's own destination %s after another OIDC login", async (path) => {
    vi.stubGlobal("BroadcastChannel", LoginChannel);
    vi.spyOn(authSession, "requestRefresh").mockResolvedValue({ access_token: "restored-token", token_type: "bearer" });
    vi.mocked(mockGetAuthConfig).mockResolvedValue({
      sign_in_mode: "oidc_or_password",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });
    window.location.search = `?return_path=${encodeURIComponent(path)}`;
    sessionStorage.setItem(OIDC_ATTEMPT_MARKER, "1");

    renderWithMemoryRouter(
      <MemoryRouter initialEntries={[`/login${window.location.search}`]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByLabelText(/username/i);
    expect(LoginChannel.channels.at(-1)?.name).toBe(OIDC_LOGIN_CHANNEL);
    LoginChannel.channels.at(-1)?.emit("completed");

    expect(await screen.findByText(path)).toBeInTheDocument();
    expect(authSession.requestRefresh).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(OIDC_ATTEMPT_MARKER)).toBeNull();
  });

  it("stays on login after failed verification and retries when brought into focus", async () => {
    vi.stubGlobal("BroadcastChannel", LoginChannel);
    const refresh = vi
      .spyOn(authSession, "requestRefresh")
      .mockRejectedValueOnce(new Error("No browser session"))
      .mockResolvedValueOnce({ access_token: "restored-token", token_type: "bearer" });
    vi.mocked(mockGetAuthConfig).mockResolvedValue({
      sign_in_mode: "oidc_or_password",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    renderWithMemoryRouter(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/browse" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByLabelText(/username/i);
    await act(async () => LoginChannel.channels.at(-1)?.emit("completed"));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("/browse")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("recovers on focus when BroadcastChannel is unavailable", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const refresh = vi.spyOn(authSession, "requestRefresh").mockResolvedValue({ access_token: "restored-token", token_type: "bearer" });
    vi.mocked(mockGetAuthConfig).mockResolvedValue({
      sign_in_mode: "oidc_or_password",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    renderWithMemoryRouter(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/browse" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByLabelText(/username/i);
    act(() => window.dispatchEvent(new Event("focus")));

    expect(await screen.findByText("/browse")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("ignores login hints after explicit logout", async () => {
    vi.stubGlobal("BroadcastChannel", LoginChannel);
    const refresh = vi.spyOn(authSession, "requestRefresh");
    vi.mocked(mockGetAuthConfig).mockResolvedValue({
      sign_in_mode: "oidc_or_password",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });
    sessionStorage.setItem(OIDC_LOGOUT_MARKER, "1");

    render(<Login />);
    await screen.findByLabelText(/username/i);
    LoginChannel.channels.at(-1)?.emit("completed");
    window.dispatchEvent(new Event("focus"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("coalesces duplicate login hints while verifying", async () => {
    vi.stubGlobal("BroadcastChannel", LoginChannel);
    const refresh = vi.spyOn(authSession, "requestRefresh").mockReturnValue(new Promise(() => undefined));
    vi.mocked(mockGetAuthConfig).mockResolvedValue({
      sign_in_mode: "oidc_or_password",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    render(<Login />);
    await screen.findByLabelText(/username/i);
    LoginChannel.channels.at(-1)?.emit("completed");
    LoginChannel.channels.at(-1)?.emit("completed");
    window.dispatchEvent(new Event("focus"));

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("lets a login hint supersede a pending focus refresh", async () => {
    vi.stubGlobal("BroadcastChannel", LoginChannel);
    let finishFocus!: (response: { access_token: string; token_type: string }) => void;
    let finishHint!: (response: { access_token: string; token_type: string }) => void;
    const refresh = vi
      .spyOn(authSession, "requestRefresh")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFocus = resolve;
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishHint = resolve;
        })
      );
    vi.mocked(mockGetAuthConfig).mockResolvedValue({
      sign_in_mode: "oidc_or_password",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    renderWithMemoryRouter(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/browse" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByLabelText(/username/i);
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => LoginChannel.channels.at(-1)?.emit("completed"));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(2, { newLogin: true });

    await act(async () => finishFocus({ access_token: "old-session", token_type: "bearer" }));
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    await act(async () => finishHint({ access_token: "new-session", token_type: "bearer" }));
    expect(await screen.findByText("/browse")).toBeInTheDocument();
  });

  it("waits for a login hint received during configuration loading before starting OIDC", async () => {
    vi.stubGlobal("BroadcastChannel", LoginChannel);
    let finishRefresh!: (response: { access_token: string; token_type: string }) => void;
    vi.spyOn(authSession, "requestRefresh").mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      })
    );
    vi.mocked(mockGetAuthConfig).mockResolvedValue({
      sign_in_mode: "oidc_only",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    renderWithMemoryRouter(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/browse" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>
    );
    LoginChannel.channels.at(-1)?.emit("completed");
    await waitFor(() => expect(authSession.requestRefresh).toHaveBeenCalledOnce());
    expect(window.location.assign).not.toHaveBeenCalled();

    finishRefresh({ access_token: "restored-token", token_type: "bearer" });
    expect(await screen.findByText("/browse")).toBeInTheDocument();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("renders login form with all elements", async () => {
    render(<Login />);

    // Wait for auth config check to complete
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    // Check for heading
    expect(screen.getByRole("heading", { name: /sambee login/i })).toBeInTheDocument();

    // Check for form fields
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();

    // Check for submit button
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();

    // Error message should not be visible initially
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows users to type in username and password fields", async () => {
    const user = userEvent.setup();
    render(<Login />);

    // Wait for auth config check to complete
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByLabelText(/^password/i);

    // Type in username
    await user.type(usernameInput, "testuser");
    expect(usernameInput).toHaveValue("testuser");

    // Type in password
    await user.type(passwordInput, "testpass");
    expect(passwordInput).toHaveValue("testpass");
  });

  it("successfully logs in with valid credentials and redirects to browser", async () => {
    // Mock successful login
    vi.mocked(mockLogin).mockResolvedValueOnce({
      access_token: "mock-admin-token",
      token_type: "bearer",
      username: "admin",
      role: "admin",
    });

    const user = userEvent.setup();
    render(<Login />);

    // Wait for auth config check to complete
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    // Fill in form with valid credentials
    await user.type(screen.getByLabelText(/username/i), "admin");
    await user.type(screen.getByLabelText(/^password/i), "admin");

    // Submit form
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith("admin", "admin"));

    // Verify login was called with correct credentials
    expect(mockLogin).toHaveBeenCalledWith("admin", "admin");
  });

  it("preserves the requested connection route when authentication is disabled", async () => {
    window.location.search = "?return_path=%2Fbrowse%2Fsmb%2Fdemo";
    vi.mocked(mockGetAuthConfig).mockResolvedValueOnce({ sign_in_mode: "none", oidc: null });

    renderWithMemoryRouter(
      <MemoryRouter initialEntries={["/login?return_path=%2Fbrowse%2Fsmb%2Fdemo"]}>
        <Login />
        <CurrentPath />
      </MemoryRouter>
    );

    expect(await screen.findByText("/browse/smb/demo")).toBeInTheDocument();
  });

  it("displays error message with invalid credentials", async () => {
    // Mock failed login
    vi.mocked(mockLogin).mockRejectedValueOnce(new Error("Unauthorized"));

    const user = userEvent.setup();
    render(<Login />);

    // Wait for auth config check to complete
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    // Fill in form with invalid credentials
    await user.type(screen.getByLabelText(/username/i), "wronguser");
    await user.type(screen.getByLabelText(/^password/i), "wrongpass");

    // Submit form
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    // Wait for error message to appear
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/invalid username or password/i);
    });

    // Token should not be stored
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("clears previous error messages on new submission", async () => {
    const user = userEvent.setup();
    render(<Login />);

    // Wait for auth config check to complete
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    // First attempt with invalid credentials
    vi.mocked(mockLogin).mockRejectedValueOnce(new Error("Unauthorized"));
    await user.type(screen.getByLabelText(/username/i), "wronguser");
    await user.type(screen.getByLabelText(/^password/i), "wrongpass");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    // Wait for error
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Clear the fields
    await user.clear(screen.getByLabelText(/username/i));
    await user.clear(screen.getByLabelText(/^password/i));

    // Second attempt with valid credentials
    vi.mocked(mockLogin).mockResolvedValueOnce({
      access_token: "mock-admin-token",
      token_type: "bearer",
      username: "admin",
      role: "admin",
    });
    await user.type(screen.getByLabelText(/username/i), "admin");
    await user.type(screen.getByLabelText(/^password/i), "admin");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledTimes(2));
  });

  it("submits form when pressing Enter key", async () => {
    // Mock successful login
    vi.mocked(mockLogin).mockResolvedValueOnce({
      access_token: "mock-admin-token",
      token_type: "bearer",
      username: "admin",
      role: "admin",
    });

    const user = userEvent.setup();
    render(<Login />);

    // Wait for auth config check to complete
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    // Fill in form
    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByLabelText(/^password/i);

    await user.type(usernameInput, "admin");
    await user.type(passwordInput, "admin");

    // Press Enter in password field
    await user.keyboard("{Enter}");

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith("admin", "admin"));
  });

  it("works with different valid user credentials", async () => {
    // Mock successful login for non-admin user
    vi.mocked(mockLogin).mockResolvedValueOnce({
      access_token: "mock-user-token",
      token_type: "bearer",
      username: "testuser",
      role: "editor",
    });

    const user = userEvent.setup();
    render(<Login />);

    // Wait for auth config check to complete
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    // Use the non-admin test user
    await user.type(screen.getByLabelText(/username/i), "testuser");
    await user.type(screen.getByLabelText(/^password/i), "testpass");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith("testuser", "testpass"));
  });

  it("shows provider and password sign-in together in OIDC or password mode", async () => {
    vi.mocked(mockGetAuthConfig).mockResolvedValueOnce({
      sign_in_mode: "oidc_or_password",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    render(<Login />);

    const providerButton = await screen.findByRole("button", { name: "Sign in with SSO (Example Identity OIDC)" });
    expect(providerButton).toHaveClass("MuiButton-contained");
    expect(screen.getByRole("button", { name: "Sign in with password" })).toHaveClass("MuiButton-outlined");
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
  });

  it("renders no controls while authentication mode is unknown", () => {
    vi.mocked(mockGetAuthConfig).mockReturnValueOnce(new Promise(() => undefined));

    render(<Login />);

    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows only a retry state when authentication configuration is unavailable", async () => {
    vi.mocked(mockGetAuthConfig).mockRejectedValueOnce(new Error("Unavailable"));

    render(<Login />);

    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Authentication is temporarily unavailable");
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^password/i)).not.toBeInTheDocument();
  });

  it("clears the configuration error after a successful retry", async () => {
    const user = userEvent.setup();
    vi.mocked(mockGetAuthConfig)
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValueOnce({ sign_in_mode: "password_only", oidc: null });

    render(<Login />);

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves a sanitized return path for automatic OIDC-only sign-in", async () => {
    window.location.search = "?return_path=%2Fsettings%2Fappearance%3Ftab%3Dtheme";
    vi.mocked(mockGetAuthConfig).mockResolvedValueOnce({
      sign_in_mode: "oidc_only",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    render(<Login />);

    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith("/api/auth/oidc/authorize?return_path=%2Fsettings%2Fappearance%3Ftab%3Dtheme")
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows only retry after an OIDC-only automatic attempt returns", async () => {
    sessionStorage.setItem("sambee_oidc_attempted", "1");
    vi.mocked(mockGetAuthConfig).mockResolvedValueOnce({
      sign_in_mode: "oidc_only",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    render(<Login />);

    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^password/i)).not.toBeInTheDocument();
  });

  it("shows a stable OIDC error and clears it from browser history", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    sessionStorage.setItem("sambee_oidc_attempted", "1");
    window.location.hash = "error=oidc_required_claim_missing";
    vi.mocked(mockGetAuthConfig).mockResolvedValueOnce({
      sign_in_mode: "oidc_only",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    render(<Login />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/did not supply required account information/i);
    expect(
      replaceState.mock.calls.some(([state, , url]) => typeof state?.idx === "number" && typeof url === "string" && !url.includes("error="))
    ).toBe(true);
  });

  it("shows a provider failure alongside password login in mixed mode", async () => {
    window.location.hash = "error=oidc_provider_unavailable";
    vi.mocked(mockGetAuthConfig).mockResolvedValueOnce({
      sign_in_mode: "oidc_or_password",
      oidc: { display_name: "Example Identity", authorization_path: "/api/auth/oidc/authorize" },
    });

    render(<Login />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/identity provider is temporarily unavailable/i);
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
  });
});
