import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRegionalLocalePreference } from "../../i18n";
import { SambeeThemeProvider } from "../../theme";
import type { CurrentAccount } from "../../types";
import { formatLocalizedDateTime } from "../../utils/localeFormatting";
import { AccountSettings } from "../AccountSettings";

vi.mock("../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "editor" }),
    getCurrentAccount: vi.fn(),
    getOidcBrowserSessions: vi.fn(),
    revokeOidcBrowserSession: vi.fn(),
    changePassword: vi.fn(),
  },
}));

vi.mock("../../services/accountSession", () => ({
  clearCurrentBrowserSession: vi.fn(),
  signOutCurrentBrowser: vi.fn(),
}));

import { clearCurrentBrowserSession, signOutCurrentBrowser } from "../../services/accountSession";
import api from "../../services/api";

const PASSWORD_ACCOUNT: CurrentAccount = {
  id: "account-id",
  username: "alex",
  name: "Alex Example",
  email: "alex@example.test",
  role: "editor",
  is_active: true,
  must_change_password: false,
  expires_at: null,
  created_at: "2026-01-01T00:00:00Z",
  has_local_password: true,
  identity_source: "local",
  password_change_available: true,
  password_change_required: false,
  browser_session_management_available: false,
  oidc_provider_name: null,
  current_session: {
    kind: "password",
    id: null,
    started_at: null,
    last_active_at: null,
    browser_name: null,
    operating_system: null,
  },
};

function renderAccount() {
  return render(
    <SambeeThemeProvider>
      <MemoryRouter initialEntries={["/settings/account"]}>
        <Routes>
          <Route path="/settings/account" element={<AccountSettings />} />
          <Route path="/login" element={<div>Login page</div>} />
        </Routes>
      </MemoryRouter>
    </SambeeThemeProvider>
  );
}

describe("AccountSettings", () => {
  afterEach(async () => {
    await setRegionalLocalePreference("browser");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCurrentAccount).mockResolvedValue(PASSWORD_ACCOUNT);
  });

  it("shows password controls without requesting OIDC sessions when they do not apply", async () => {
    renderAccount();

    expect(await screen.findByText("Alex Example")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Account" })).toHaveLength(1);
    expect(screen.getByText("Manage your identity, password, sessions, and sign-out.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your identity" })).toBeInTheDocument();
    expect(screen.queryByText("Your signed-in identity and access level.")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Your identity" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Username" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Identity source" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Local" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change password" })).toHaveStyle({ alignSelf: "flex-start" });
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "This browser", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("Password sign-in")).toBeInTheDocument();
    expect(screen.getByText("Sign-in time unavailable.")).toBeInTheDocument();
    expect(api.getOidcBrowserSessions).not.toHaveBeenCalled();
  });

  it("formats session timestamps with the selected regional locale", async () => {
    const startedAt = "2026-01-02T03:04:05Z";
    await setRegionalLocalePreference("de-DE");
    vi.mocked(api.getCurrentAccount).mockResolvedValue({
      ...PASSWORD_ACCOUNT,
      current_session: {
        ...PASSWORD_ACCOUNT.current_session,
        started_at: startedAt,
      },
    });

    renderAccount();

    expect(await screen.findByText(`Started ${formatLocalizedDateTime(startedAt, {})}.`)).toBeInTheDocument();
  });

  it("loads OIDC sessions only when the account supports them without adding a duplicate section divider", async () => {
    vi.mocked(api.getCurrentAccount).mockResolvedValue({
      ...PASSWORD_ACCOUNT,
      identity_source: "oidc",
      password_change_available: false,
      browser_session_management_available: true,
      oidc_provider_name: "Company SSO",
      current_session: {
        kind: "oidc",
        id: "session-id",
        started_at: "2026-01-01T00:00:00Z",
        last_active_at: null,
        browser_name: "Chrome",
        operating_system: "Windows",
      },
    });
    vi.mocked(api.getOidcBrowserSessions).mockResolvedValue({
      sessions: [
        {
          id: "session-id",
          status: "active",
          browser_name: "Chrome",
          operating_system: "Windows",
          created_at: "2026-01-01T00:00:00Z",
          authenticated_at: "2026-01-01T00:00:00Z",
          last_seen_at: null,
          last_refreshed_at: null,
          current: true,
        },
        {
          id: "other-session-id",
          status: "active",
          browser_name: "Firefox",
          operating_system: "macOS",
          created_at: "2026-01-02T00:00:00Z",
          authenticated_at: "2026-01-02T00:00:00Z",
          last_seen_at: null,
          last_refreshed_at: null,
          current: false,
        },
        {
          id: "unlabeled-other-session-id",
          status: "active",
          browser_name: null,
          operating_system: null,
          created_at: "2026-01-03T00:00:00Z",
          authenticated_at: "2026-01-03T00:00:00Z",
          last_seen_at: null,
          last_refreshed_at: null,
          current: false,
        },
      ],
    });

    renderAccount();

    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "This browser", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Other sessions", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("Firefox on macOS")).toBeInTheDocument();
    expect(screen.getByText("Browser session")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "OIDC" })).toBeInTheDocument();
    expect(screen.getByText("Chrome on Windows").closest("li")).not.toHaveClass("MuiListItem-divider");
    expect(screen.getByText("Firefox on macOS").closest("li")).toHaveClass("MuiListItem-divider");
    expect(screen.getByText("Browser session").closest("li")).not.toHaveClass("MuiListItem-divider");
    expect(api.getOidcBrowserSessions).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Password" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Revoke all other sessions" })).not.toBeInTheDocument();
  });

  it("shows a retry action instead of loading indefinitely when account loading fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentAccount).mockRejectedValueOnce(new Error("Offline"));
    renderAccount();

    expect(await screen.findByText("Account information could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading account")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Alex Example")).toBeInTheDocument();
  });

  it("does not report an empty session list when OIDC session loading fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentAccount).mockResolvedValue({
      ...PASSWORD_ACCOUNT,
      password_change_available: false,
      browser_session_management_available: true,
      current_session: {
        kind: "oidc",
        id: "session-id",
        started_at: "2026-01-01T00:00:00Z",
        last_active_at: null,
        browser_name: null,
        operating_system: null,
      },
    });
    vi.mocked(api.getOidcBrowserSessions).mockRejectedValueOnce(new Error("Offline"));
    vi.mocked(api.getOidcBrowserSessions).mockResolvedValueOnce({
      sessions: [
        {
          id: "session-id",
          status: "active",
          browser_name: null,
          operating_system: null,
          created_at: "2026-01-01T00:00:00Z",
          authenticated_at: "2026-01-01T00:00:00Z",
          last_seen_at: null,
          last_refreshed_at: null,
          current: true,
        },
      ],
    });
    renderAccount();

    expect(await screen.findByText("Other sessions could not be loaded.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "This browser", level: 3 })).toBeInTheDocument();
  });

  it("explains that session information is unavailable when authentication is not enforced", async () => {
    vi.mocked(api.getCurrentAccount).mockResolvedValue({
      ...PASSWORD_ACCOUNT,
      password_change_available: false,
      current_session: null,
    });

    renderAccount();

    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Session information is not available because authentication is not enforced.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "This browser", level: 3 })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("clears only this tab after revoking the current OIDC session", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentAccount).mockResolvedValue({
      ...PASSWORD_ACCOUNT,
      identity_source: "oidc",
      password_change_available: false,
      browser_session_management_available: true,
      current_session: {
        kind: "oidc",
        id: "current-session-id",
        started_at: "2026-01-01T00:00:00Z",
        last_active_at: null,
        browser_name: "Firefox",
        operating_system: "Linux",
      },
    });
    vi.mocked(api.getOidcBrowserSessions).mockResolvedValue({
      sessions: [
        {
          id: "current-session-id",
          status: "active",
          browser_name: "Firefox",
          operating_system: "Linux",
          created_at: "2026-01-01T00:00:00Z",
          authenticated_at: "2026-01-01T00:00:00Z",
          last_seen_at: null,
          last_refreshed_at: null,
          current: true,
        },
      ],
    });
    vi.mocked(api.revokeOidcBrowserSession).mockResolvedValue({ revoked_count: 1 });

    renderAccount();

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(api.revokeOidcBrowserSession).toHaveBeenCalledWith("current-session-id"));
    expect(clearCurrentBrowserSession).toHaveBeenCalledTimes(1);
    expect(signOutCurrentBrowser).not.toHaveBeenCalled();
    expect(await screen.findByText("Login page")).toBeInTheDocument();
  });

  it("validates a mismatched password confirmation before submitting", async () => {
    const user = userEvent.setup();
    renderAccount();

    await screen.findByRole("heading", { name: "Password" });
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Confirm new password"), "different-password");

    expect(await screen.findByText("The new password and confirmation do not match.")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("aria-invalid", "true");
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it("changes the local password then signs out", async () => {
    const user = userEvent.setup();
    renderAccount();

    await screen.findByRole("heading", { name: "Password" });
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Confirm new password"), "new-password");
    expect(screen.getByLabelText("Current password")).toHaveValue("old-password");
    expect(screen.getByLabelText("New password")).toHaveValue("new-password");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("new-password");
    await user.click(within(screen.getByRole("dialog", { name: "Change password" })).getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith("old-password", "new-password"));
    await waitFor(() => expect(signOutCurrentBrowser).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Login page")).toBeInTheDocument();
  });

  it("shows a failed password change as an action-result notice", async () => {
    const user = userEvent.setup();
    vi.mocked(api.changePassword).mockRejectedValueOnce({ response: { data: { detail: "Password rejected." } } });
    renderAccount();

    await screen.findByRole("heading", { name: "Password" });
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Confirm new password"), "new-password");
    await user.click(within(screen.getByRole("dialog", { name: "Change password" })).getByRole("button", { name: "Change password" }));

    expect(await screen.findByTestId("change-password-error")).toHaveTextContent("Password rejected.");
    expect(screen.getByTestId("change-password-error")).toHaveAttribute("role", "alert");
  });

  it("supports password visibility and cancellation in the change dialog", async () => {
    const user = userEvent.setup();
    renderAccount();

    await screen.findByRole("heading", { name: "Password" });
    const changePasswordButton = screen.getByRole("button", { name: "Change password" });
    await user.click(changePasswordButton);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toHaveFocus());
    expect(screen.queryByTestId("change-password-error")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show new password" }));
    expect(screen.getByRole("button", { name: "Hide new password" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument());
    expect(changePasswordButton).toHaveFocus();
  });

  it("signs out from the account action", async () => {
    const user = userEvent.setup();
    renderAccount();

    await screen.findByText("Alex Example");
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(signOutCurrentBrowser).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Login page")).toBeInTheDocument();
  });
});
