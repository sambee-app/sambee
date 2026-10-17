import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signOutCurrentBrowser } from "../../services/accountSession";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { PASSWORD_CHANGED_MARKER, setPasswordChangeRequired } from "../../services/passwordChange";
import type { CurrentAccount } from "../../types";
import PasswordChange, { PasswordChangeGate } from "../PasswordChange";

vi.mock("../../services/api", () => ({ default: { getCurrentAccount: vi.fn(), changePassword: vi.fn() } }));
vi.mock("../../services/accountSession", () => ({ signOutCurrentBrowser: vi.fn() }));
vi.mock("../../services/authSession", () => ({
  authSession: { hasUsableAccessToken: vi.fn(() => true), subscribeToIdentity: vi.fn(() => () => undefined) },
}));

const account: CurrentAccount = {
  id: "user-1",
  username: "alex",
  role: "editor",
  is_active: true,
  must_change_password: true,
  expires_at: null,
  created_at: "2026-01-01T00:00:00Z",
  has_local_password: true,
  identity_source: "local",
  password_change_available: true,
  password_change_required: true,
  browser_session_management_available: false,
  oidc_provider_name: null,
  current_session: null,
};

function renderWorkflow(path = "/change-password?return_path=%2Fbrowse%2Fsmb%2Fdemo") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/change-password" element={<PasswordChange />} />
        <Route element={<PasswordChangeGate ready />}>
          <Route path="/browse/*" element={<div>Protected content</div>} />
        </Route>
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("mandatory password change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    setPasswordChangeRequired(false);
    vi.mocked(api.getCurrentAccount).mockResolvedValue(account);
    vi.mocked(api.changePassword).mockResolvedValue(undefined);
    vi.mocked(signOutCurrentBrowser).mockResolvedValue(undefined);
    vi.mocked(authSession.hasUsableAccessToken).mockReturnValue(true);
  });

  it("requires matching passwords and signs out after a successful change", async () => {
    const user = userEvent.setup();
    renderWorkflow();
    const current = await screen.findByLabelText(/^Current password/);
    expect(current).toHaveFocus();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    await user.type(current, "temporary-password");
    await user.type(screen.getByLabelText(/^New password/), "new-password");
    await user.type(screen.getByLabelText(/^Confirm new password/), "wrong");
    expect(screen.getByText("The passwords do not match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
    await user.clear(screen.getByLabelText(/^Confirm new password/));
    await user.type(screen.getByLabelText(/^Confirm new password/), "new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(api.changePassword).toHaveBeenCalledWith("temporary-password", "new-password");
    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(signOutCurrentBrowser).toHaveBeenCalled();
    expect(sessionStorage.getItem(PASSWORD_CHANGED_MARKER)).toBe("1");
  });

  it("keeps the user on the change screen when the API rejects the change", async () => {
    vi.mocked(api.changePassword).mockRejectedValue(new Error("Password change failed"));
    const user = userEvent.setup();
    renderWorkflow();
    await user.type(await screen.findByLabelText(/^Current password/), "temporary-password");
    await user.type(screen.getByLabelText(/^New password/), "new-password");
    await user.type(screen.getByLabelText(/^Confirm new password/), "new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(signOutCurrentBrowser).not.toHaveBeenCalled();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("allows sign-out without changing the password", async () => {
    const user = userEvent.setup();
    renderWorkflow();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it("does not mount protected content before checking effective account state", async () => {
    let resolve!: (value: CurrentAccount) => void;
    vi.mocked(api.getCurrentAccount).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    renderWorkflow("/browse/smb/demo");
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    await act(async () => resolve(account));
    expect(await screen.findByLabelText(/^Current password/)).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("allows a validated OIDC account with a pending local-password flag", async () => {
    vi.mocked(api.getCurrentAccount).mockResolvedValue({ ...account, password_change_required: false });
    renderWorkflow("/browse/smb/demo");
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
  });

  it("reacts to a password-change restriction discovered by another API request", async () => {
    vi.mocked(api.getCurrentAccount).mockResolvedValueOnce({ ...account, password_change_required: false });
    renderWorkflow("/browse/smb/demo");
    expect(await screen.findByText("Protected content")).toBeInTheDocument();
    act(() => setPasswordChangeRequired(true));
    await waitFor(() => expect(screen.queryByText("Protected content")).not.toBeInTheDocument());
    expect(await screen.findByLabelText(/^Current password/)).toBeInTheDocument();
  });
});
