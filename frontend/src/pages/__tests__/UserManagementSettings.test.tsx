import { act, render as renderBase, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCachedAsyncData,
  clearCachedAsyncDataByPrefix,
  getCachedAsyncData,
  primeCachedAsyncData,
} from "../../hooks/useCachedAsyncData";
import { setRegionalLocalePreference } from "../../i18n";
import { createMockAdminUser, createMockAdminUserList } from "../../test/fixtures/users";
import { requireTestElement, requireTestValue } from "../../test/helpers/assertions";
import { SambeeThemeProvider } from "../../theme";
import type { AdminUserCreateResult, AdminUserPasswordResetResult } from "../../types";
import { USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY, UserManagementSettings } from "../UserManagementSettings";

let testRouter: ReturnType<typeof createMemoryRouter>;
const render = (ui: ReactNode) => {
  const url = new URL(document.URL);
  testRouter = createMemoryRouter([{ path: "*", element: ui }], { initialEntries: [url.pathname + url.search] });
  return renderBase(<RouterProvider router={testRouter} />);
};

vi.mock("../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getUsers: vi.fn(),
    getCurrentUser: vi.fn(),
    getOidcConfiguration: vi.fn(),
    moveOidcIdentity: vi.fn(),
    cancelPendingOidcMapping: vi.fn(),
    detachOidcIdentity: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    resetUserPassword: vi.fn(),
    deleteUser: vi.fn(),
  },
  isControlledReauthenticationInProgress: vi.fn(),
}));

import api, { isControlledReauthenticationInProgress } from "../../services/api";

function mockViewportWidth(width: number) {
  const originalMatchMedia = window.matchMedia;

  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const minWidth = Number(query.match(/min-width:\s*([\d.]+)px/)?.[1]);
    const maxWidth = Number(query.match(/max-width:\s*([\d.]+)px/)?.[1]);
    const matches = (Number.isNaN(minWidth) || width >= minWidth) && (Number.isNaN(maxWidth) || width <= maxWidth);

    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });

  return () => {
    window.matchMedia = originalMatchMedia;
  };
}

async function openUserActions(user: ReturnType<typeof userEvent.setup>, username: string) {
  await user.click(await screen.findByRole("button", { name: `User actions for ${username}` }));
}

function mockOidcAuthenticationEnabled() {
  vi.mocked(api.getOidcConfiguration).mockResolvedValue({
    configuration: null,
    health: { status: "healthy", public_url_configured: false, public_url: null, redirect_uri: null, reasons: [] },
    active_passwordless_user_count: 0,
    auth_mode: "oidc_or_password",
    auth_enforcement_disabled: false,
  });
}

describe("UserManagementSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAsyncData();
    window.localStorage.removeItem(USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY);
    window.history.replaceState(null, "", window.location.pathname);
    vi.mocked(isControlledReauthenticationInProgress).mockReturnValue(false);
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "admin",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    vi.mocked(api.getCurrentUser).mockResolvedValue({
      id: "user-1",
      username: "admin",
      role: "admin",
    });
    vi.mocked(api.getOidcConfiguration).mockResolvedValue({
      configuration: null,
      health: { status: "healthy", public_url_configured: false, public_url: null, redirect_uri: null, reasons: [] },
      active_passwordless_user_count: 0,
      auth_mode: "password_only",
      auth_enforcement_disabled: false,
    });
    vi.mocked(api.resetUserPassword).mockResolvedValue({
      message: "Password reset",
    });
  });

  it("invalidates every cached directory query after a user mutation", async () => {
    const directoryCachePrefix = "settings-data/admin-users:";
    const firstDirectoryKey = `${directoryCachePrefix}{"page":1}`;
    const secondDirectoryKey = `${directoryCachePrefix}{"page":2}`;
    const unrelatedKey = "settings-data/current-user";
    await Promise.all([
      primeCachedAsyncData(firstDirectoryKey, async () => "first"),
      primeCachedAsyncData(secondDirectoryKey, async () => "second"),
      primeCachedAsyncData(unrelatedKey, async () => "unrelated"),
    ]);

    clearCachedAsyncDataByPrefix(directoryCachePrefix);

    expect(getCachedAsyncData(firstDirectoryKey)).toBeNull();
    expect(getCachedAsyncData(secondDirectoryKey)).toBeNull();
    expect(getCachedAsyncData(unrelatedKey)).toBe("unrelated");
  });

  it("shows username conflicts even for an empty directory and clears resolved conflicts", async () => {
    const directory = {
      items: [],
      total: 0,
      summary: { total: 0, active_admins: 0, disabled: 0, expiring_soon: 0, pending_oidc: 0, unavailable_sign_in: 0 },
      username_conflicts: [["UserA", "usera"]],
    };
    vi.mocked(api.getUsers).mockResolvedValue(directory);
    const view = render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );
    const warning = await screen.findByText(/These accounts have conflicting usernames/);
    expect(warning.closest('[role="status"]')).toHaveTextContent("UserA, usera");
    expect(warning).toHaveTextContent("exact spelling");
    view.unmount();
    clearCachedAsyncData();
    vi.mocked(api.getUsers).mockResolvedValue({ ...directory, username_conflicts: [] });
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );
    await waitFor(() => expect(api.getUsers).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: /add user/i });
    expect(screen.queryByText(/These accounts have conflicting usernames/)).not.toBeInTheDocument();
  });

  it("opens the create-user dialog with outlined form controls", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(api.getUsers).toHaveBeenCalled();
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: /add user/i }));

    const usernameInput = await screen.findByLabelText(/username/i);
    const roleSelect = screen.getByRole("combobox", { name: /role/i });
    const passwordInput = screen.getByLabelText(/^initial password$/i);

    expect(usernameInput.closest(".MuiOutlinedInput-root")).not.toBeNull();
    expect(roleSelect.closest(".MuiOutlinedInput-root")).not.toBeNull();
    expect(roleSelect).toHaveTextContent("Editor");
    expect(passwordInput.closest(".MuiOutlinedInput-root")).not.toBeNull();

    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create user/i })).toBeInTheDocument();
  });

  it("marks the current account in the user title instead of metadata", async () => {
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    const userRow = await screen.findByTestId("user-row");
    expect(userRow).toHaveTextContent("admin (you)");
    expect(within(screen.getByTestId("user-metadata")).queryByText("You", { exact: true })).not.toBeInTheDocument();
  });

  it("shows the username beneath a local account without a full name", async () => {
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    const username = await screen.findByText("admin", { exact: true });
    expect(username).toHaveClass("MuiTypography-body2");
  });

  it("uses the inline bold username confirmation when deleting another user", async () => {
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "admin",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-2",
          username: "other-user",
          role: "viewer",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await openUserActions(user, "other-user");
    await user.click(await screen.findByRole("menuitem", { name: "Delete user" }));

    const deleteDialog = screen.getByRole("dialog", { name: "Delete User" });
    expect(within(deleteDialog).getByText("other-user", { exact: true }).tagName).toBe("STRONG");
    expect(within(deleteDialog).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it.each(["oidc_only", "none"] as const)("hides local-user and password controls in %s mode", async (authMode) => {
    vi.mocked(api.getOidcConfiguration).mockResolvedValue({
      configuration: null,
      health: { status: "healthy", public_url_configured: false, public_url: null, redirect_uri: null, reasons: [] },
      active_passwordless_user_count: 0,
      auth_mode: authMode,
      auth_enforcement_disabled: false,
    });

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await screen.findByText("admin (you)", { exact: true });

    expect(screen.queryByRole("button", { name: /add user/i })).not.toBeInTheDocument();
    await openUserActions(userEvent.setup(), "admin");
    expect(screen.queryByRole("menuitem", { name: /reset password/i })).not.toBeInTheDocument();
  });

  it("uses external descriptions and grouped sections in the desktop add-user editor", async () => {
    const restoreViewport = mockViewportWidth(1200);
    const user = userEvent.setup();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await waitFor(() => {
        expect(api.getUsers).toHaveBeenCalled();
        expect(api.getCurrentUser).toHaveBeenCalled();
      });

      await user.click(screen.getByRole("button", { name: /add user/i }));

      expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^full name$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: /^role$/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/expiration time/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^initial password$/i)).toBeInTheDocument();

      const descriptions = [
        "Unique sign-in name",
        "Displayed account name",
        "Optional contact email",
        "Choose an access level",
        "Leave blank for no expiration",
        "If left blank, the server will generate a secure temporary password",
        "Block local-password access until the password is changed. OIDC sign-in remains available.",
      ];

      for (const description of descriptions) {
        expect(screen.getByText(description)).not.toHaveClass("MuiFormHelperText-root");
      }

      const formSurface = screen.getByTestId("user-editor-form-surface");
      expect(formSurface).toContainElement(screen.getByTestId("user-editor-identity-fields"));
      expect(screen.getByRole("heading", { name: "Access", level: 2 })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Credentials", level: 2 })).toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });

  it("uses consistent field descriptions in the edit-user editor", async () => {
    const restoreViewport = mockViewportWidth(1200);
    const user = userEvent.setup();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await user.click(await screen.findByRole("button", { name: /edit admin/i }));

      expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: /^role$/i })).toBeInTheDocument();
      expect(screen.getByText("Optional contact email")).not.toHaveClass("MuiFormHelperText-root");
      expect(screen.getByText("Choose an access level")).not.toHaveClass("MuiFormHelperText-root");
      expect(screen.getByText("Disabled accounts cannot sign in")).not.toHaveClass("MuiFormHelperText-root");
      expect(screen.getByText("On")).toBeInTheDocument();
      expect(screen.getByLabelText(/account is active: on/i)).toBeDisabled();
      expect(screen.queryByText("Update account details and access level. Password resets are handled separately")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Credentials", level: 2 })).not.toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });

  it("keeps floating labels and helper text in the narrow dialog layout", async () => {
    const restoreViewport = mockViewportWidth(800);

    try {
      const user = userEvent.setup();
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await user.click(await screen.findByRole("button", { name: /add user/i }));

      const usernameLabel = screen.getByText("Username", { selector: "label" });
      const usernameInput = screen.getByLabelText(/username/i);

      expect(screen.queryByTestId("responsive-form-dialog-mobile-actions")).not.toBeInTheDocument();
      expect(document.querySelector(".MuiDialog-paperWidthSm")).not.toBeNull();
      expect(usernameLabel).toHaveClass("MuiInputLabel-root");
      expect(usernameInput.parentElement).not.toHaveClass("MuiInputBase-sizeSmall");
      expect(screen.getByText("Unique sign-in name")).toHaveClass("MuiFormHelperText-root");
    } finally {
      restoreViewport();
    }
  });

  it("uses compact desktop controls and focuses the first invalid user-editor field", async () => {
    const restoreViewport = mockViewportWidth(1200);

    try {
      const user = userEvent.setup();
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await user.click(await screen.findByRole("button", { name: /add user/i }));

      const usernameInput = screen.getByLabelText(/username/i);
      expect(screen.getByText("Username", { selector: "label" })).toHaveAttribute("for", "user-editor-username");
      expect(usernameInput.parentElement).toHaveClass("MuiInputBase-sizeSmall");
      expect(screen.getByText("Unique sign-in name")).not.toHaveClass("MuiFormHelperText-root");

      await user.click(screen.getByRole("button", { name: /create user/i }));

      await waitFor(() => {
        expect(usernameInput).toHaveFocus();
        expect(usernameInput).toHaveAttribute("aria-describedby", "user-editor-username-description");
        expect(screen.getByText("Username is required")).not.toHaveClass("MuiFormHelperText-root");
      });
    } finally {
      restoreViewport();
    }
  });

  it("uses the role selector and read-only identity fields for linked OIDC users", async () => {
    mockOidcAuthenticationEnabled();
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "admin",
          name: "OIDC Admin",
          email: "admin@example.test",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: { identity_id: "identity-1", provider_display_name: "Corporate login", last_login_at: null, inherited_role: "editor" },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await user.click(await screen.findByRole("button", { name: /edit admin/i }));

    expect(screen.getByRole("combobox", { name: /^role$/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("combobox", { name: /oidc role assignment/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^full name$/i)).toHaveAttribute("readonly");
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute("readonly");
    expect(screen.getAllByText("Managed by the linked OIDC provider")).toHaveLength(2);
    expect(screen.queryByLabelText(/initial password/i)).not.toBeInTheDocument();
  });

  it("shows the inherited OIDC role and clears an individual override", async () => {
    mockOidcAuthenticationEnabled();
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "admin",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-2",
          username: "oidc-user",
          name: "OIDC User",
          email: "oidc-user@example.test",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: "admin",
          oidc: { identity_id: "identity-2", provider_display_name: "Corporate login", last_login_at: null, inherited_role: "viewer" },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await user.click(await screen.findByRole("button", { name: "Edit oidc-user" }));

    const roleSelect = screen.getByRole("combobox", { name: /^role$/i });
    expect(roleSelect).toHaveTextContent("Admin");
    await user.click(roleSelect);
    expect(await screen.findByRole("option", { name: /inherited \(viewer\)/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^viewer browse content$/i })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /inherited \(viewer\)/i }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(api.updateUser).toHaveBeenCalledWith("user-2", {
        username: "oidc-user",
        role: "viewer",
        oidc_role_assignment: null,
        is_active: true,
        expires_at: null,
      });
    });
  });

  it("does not offer an inherited role for a pending OIDC mapping", async () => {
    mockOidcAuthenticationEnabled();
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "admin",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-2",
          username: "pending-user",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: "admin",
          oidc: null,
          pending_oidc: {
            expected_username: "provider-user",
            created_by_username: "admin",
            created_at: "2026-03-01T10:00:00Z",
          },
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await user.click(await screen.findByRole("button", { name: "Edit pending-user" }));
    await user.click(screen.getByRole("combobox", { name: /^role$/i }));

    expect(screen.queryByRole("option", { name: /inherited/i })).not.toBeInTheDocument();
    expect(
      screen.getByText("Choose an individual override. The provider-derived role will be available after the user's next OIDC sign-in")
    ).toBeInTheDocument();
  });

  it("does not offer an inherited role until a linked OIDC account has a verified role", async () => {
    mockOidcAuthenticationEnabled();
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "admin",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-2",
          username: "unresolved-oidc-user",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: "admin",
          oidc: { identity_id: "identity-2", provider_display_name: "Corporate login", last_login_at: null, inherited_role: null },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await user.click(await screen.findByRole("button", { name: "Edit unresolved-oidc-user" }));
    await user.click(screen.getByRole("combobox", { name: /^role$/i }));

    expect(screen.queryByRole("option", { name: /inherited/i })).not.toBeInTheDocument();
  });

  it("reports an existing username while editing", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await user.click(await screen.findByRole("button", { name: /add user/i }));
    await user.type(await screen.findByRole("textbox", { name: /^username$/i }), "admin");

    expect(screen.getByText("A user with that username already exists")).toBeInTheDocument();
  });

  it("shows role-specific descriptions and supports password visibility and password-change state", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await user.click(await screen.findByRole("button", { name: /add user/i }));

    const roleSelect = screen.getByRole("combobox", { name: /^role$/i });
    await user.click(roleSelect);
    expect(await screen.findByText("Modify content")).toBeInTheDocument();
    expect(screen.getByText("Browse content")).toBeInTheDocument();
    expect(screen.getByText("Manage settings, users, and content")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const passwordInput = screen.getByLabelText(/^initial password$/i);
    expect(passwordInput).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: /show initial password/i }));
    expect(passwordInput).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: /hide initial password/i })).toBeInTheDocument();

    const passwordChangeSwitch = screen.getByLabelText(/require change on next password sign-in/i);
    expect(screen.getByText("On")).toBeInTheDocument();
    await user.click(passwordChangeSwitch);
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("renders user names as bold body text instead of headings", async () => {
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    const userName = await screen.findByText("admin (you)", { exact: true });

    expect(screen.queryByRole("heading", { name: "admin (you)" })).not.toBeInTheDocument();
    expect(userName.tagName).toBe("DIV");
    expect(userName).toHaveClass("MuiTypography-body1");
    expect(window.getComputedStyle(userName).fontWeight).toBe("600");
  });

  it("uses sortable column headers instead of a sort dropdown", async () => {
    const restoreViewport = mockViewportWidth(1200);
    const user = userEvent.setup();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      const header = await screen.findByTestId("user-directory-header");
      const roleSort = within(header).getByRole("button", { name: "Sort by Role" });

      expect(screen.queryByRole("combobox", { name: "Sort" })).not.toBeInTheDocument();
      expect(roleSort).toHaveAttribute("tabindex", "-1");
      await user.click(roleSort);
      await waitFor(() => {
        expect(
          within(screen.getByTestId("user-directory-header"))
            .getByRole("button", { name: "Sort by Role, ascending" })
            .closest('[role="columnheader"]')
        ).toHaveAttribute("aria-sort", "ascending");
      });

      await user.click(within(screen.getByTestId("user-directory-header")).getByRole("button", { name: "Sort by Role, ascending" }));
      await waitFor(() => {
        expect(
          within(screen.getByTestId("user-directory-header"))
            .getByRole("button", { name: "Sort by Role, descending" })
            .closest('[role="columnheader"]')
        ).toHaveAttribute("aria-sort", "descending");
      });
    } finally {
      restoreViewport();
    }
  });

  it("keeps password-only headers and rows in matching columns and skips sort headers while tabbing", async () => {
    const restoreViewport = mockViewportWidth(1200);
    const user = userEvent.setup();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      const header = await screen.findByTestId("user-directory-header");
      const row = await screen.findByTestId("user-row");

      expect(header.querySelectorAll('[role="columnheader"]')).toHaveLength(6);
      expect(row.children).toHaveLength(6);
      expect(screen.getByTestId("user-row-role")).toHaveTextContent("Admin");
      expect(row.querySelector(".MuiChip-root")).toBeNull();
      const sortButtons = within(header).getAllByRole("button", { name: /^Sort by/ });
      expect(sortButtons).toHaveLength(5);
      for (const sortButton of sortButtons) {
        expect(sortButton).toHaveAttribute("tabindex", "-1");
      }
      expect(screen.getAllByRole("button", { name: "Columns" })).toHaveLength(1);
      const headerColumnsButton = within(header.lastElementChild as HTMLElement).getByRole("button", { name: "Manage visible columns" });

      await user.tab();
      expect(screen.getByRole("textbox", { name: "Search users" })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "Columns" })).toHaveFocus();
      await user.tab();
      expect(headerColumnsButton).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "Edit admin" })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "User actions for admin" })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("combobox")).toHaveFocus();
      await user.tab();
      expect(screen.queryByRole("button", { name: "page 1" })).not.toHaveFocus();
    } finally {
      restoreViewport();
    }
  });

  it("keeps the header column menu open through selection changes and restores focus to the visible trigger", async () => {
    const restoreViewport = mockViewportWidth(1200);
    const user = userEvent.setup();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await screen.findByTestId("user-directory-header");
      const columnsButton = within(screen.getByTestId("user-directory-header")).getByRole("button", { name: "Manage visible columns" });
      const headerBounds = vi.spyOn(columnsButton, "getBoundingClientRect").mockReturnValue(new DOMRect(800, 200, 28, 28));
      await user.click(columnsButton);
      const expectStableTrigger = () => {
        expect(screen.getByRole("button", { name: "Manage visible columns", hidden: true })).toBe(columnsButton);
        expect(columnsButton).toBeVisible();
        expect(columnsButton).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("menu")).toBeVisible();
      };
      await user.click(screen.getByRole("menuitemcheckbox", { name: "Email" }));
      expect(screen.getByTestId("user-row").children).toHaveLength(7);
      expectStableTrigger();
      await user.click(screen.getByRole("menuitemcheckbox", { name: "Expiration" }));

      expect(within(screen.getByTestId("user-directory-header")).queryByText("Expiration", { exact: true })).not.toBeInTheDocument();
      expect(screen.getByTestId("user-row").children).toHaveLength(6);
      expect(JSON.parse(window.localStorage.getItem(USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY) ?? "[]")).not.toContain("expiration");
      expectStableTrigger();

      await user.click(screen.getByRole("menuitem", { name: "Reset columns" }));

      expect(within(screen.getByTestId("user-directory-header")).getByText("Expiration", { exact: true })).toBeInTheDocument();
      expect(screen.getByTestId("user-row").children).toHaveLength(6);
      expect(window.localStorage.getItem(USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY)).toBeNull();
      expectStableTrigger();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      expect(columnsButton).toHaveFocus();
      expect(columnsButton).toHaveAttribute("aria-expanded", "false");
      await user.click(columnsButton);
      headerBounds.mockReturnValue(new DOMRect());
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Columns" })).toHaveFocus();
      headerBounds.mockRestore();
    } finally {
      restoreViewport();
    }
  });

  it("offers audit and contact columns while hiding OIDC-only choices when OIDC is disabled", async () => {
    const restoreViewport = mockViewportWidth(1200);
    const user = userEvent.setup();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await screen.findByTestId("user-directory-header");
      await user.click(screen.getByRole("button", { name: "Columns" }));

      expect(screen.getByRole("menuitemcheckbox", { name: "Email" })).toBeInTheDocument();
      expect(screen.getByRole("menuitemcheckbox", { name: "Created" })).toBeInTheDocument();
      expect(screen.getByRole("menuitemcheckbox", { name: "Last updated" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitemcheckbox", { name: "Last OIDC sign-in" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitemcheckbox", { name: "OIDC state" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitemcheckbox", { name: "Role source" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitemcheckbox", { name: "OIDC provider" })).not.toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });

  it("offers OIDC metadata columns when OIDC is enabled", async () => {
    const restoreViewport = mockViewportWidth(1200);
    const user = userEvent.setup();
    mockOidcAuthenticationEnabled();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await screen.findByTestId("user-directory-header");
      await user.click(screen.getByRole("button", { name: "Columns" }));

      expect(screen.getByRole("menuitemcheckbox", { name: "Last OIDC sign-in" })).toBeInTheDocument();
      expect(screen.getByRole("menuitemcheckbox", { name: "OIDC state" })).toBeInTheDocument();
      expect(screen.getByRole("menuitemcheckbox", { name: "Role source" })).toBeInTheDocument();
      expect(screen.getByRole("menuitemcheckbox", { name: "OIDC provider" })).toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });

  it("keeps the Sign-in column visible at medium desktop widths in mixed OIDC/password mode", async () => {
    const restoreViewport = mockViewportWidth(1000);
    mockOidcAuthenticationEnabled();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      const header = await screen.findByTestId("user-directory-header");
      const row = await screen.findByTestId("user-row");

      expect(within(header).getByRole("columnheader", { name: "Sign-in" })).toHaveStyle({ display: "flex" });
      expect(row.querySelector('[data-testid="user-row-sign-in"]')?.parentElement).toHaveStyle({ display: "flex" });
    } finally {
      restoreViewport();
    }
  });

  it("uses an ordered single-column record layout on phones", async () => {
    const restoreViewport = mockViewportWidth(390);

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      const row = await screen.findByTestId("user-row");
      const cellText = Array.from(row.children).map((cell) => cell.textContent);

      expect(screen.getByRole("button", { name: "Columns" })).toBeInTheDocument();
      expect(cellText).toEqual([
        expect.stringContaining("admin (you)"),
        expect.stringContaining("RoleAdmin"),
        expect.stringContaining("StatusActive"),
        expect.stringContaining("Sign-in: Password"),
        expect.stringContaining("Expiration: Never"),
        "",
      ]);
      const actionsCell = within(requireTestElement(row.children[5], HTMLElement));
      expect(actionsCell.getByRole("button", { name: "Edit admin" })).toBeInTheDocument();
      expect(actionsCell.getByRole("button", { name: "User actions for admin" })).toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });

  it("keeps long identifiers and multiple statuses as full plain text with compact localized timestamps", async () => {
    const timestamp = "2026-03-01T10:00:00Z";
    const email = "very.long.email.address.without.breaks@example-with-a-very-long-domain.example";
    const provider = "VeryLongIdentityProviderNameWithoutSpaces";
    const columns = [
      "role",
      "status",
      "signIn",
      "lastSignIn",
      "expiration",
      "email",
      "createdAt",
      "updatedAt",
      "oidcState",
      "roleSource",
      "oidcProvider",
    ];
    window.localStorage.setItem(USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(columns));
    mockOidcAuthenticationEnabled();
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "long-user",
          username: "very-long-username-without-spaces",
          name: "Layout test",
          email,
          role: "admin",
          is_active: false,
          must_change_password: true,
          has_local_password: true,
          expires_at: "2025-01-01T10:00:00Z",
          created_at: timestamp,
          updated_at: timestamp,
          oidc_role_assignment: "admin",
          pending_oidc: null,
          oidc: {
            identity_id: "identity",
            user_id: "long-user",
            provider_display_name: provider,
            issuer: "https://idp.example",
            subject: "subject",
            last_seen_username: "long-user",
            last_groups: [],
            created_at: timestamp,
            last_login_at: timestamp,
          },
        }),
      ])
    );
    await setRegionalLocalePreference("de-DE");
    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );
      const row = await screen.findByTestId("user-row");
      expect(row.querySelector(".MuiChip-root")).toBeNull();
      expect(row.children).toHaveLength(columns.length + 2);
      expect(screen.getByTestId("user-row-email")).toHaveTextContent(email);
      expect(screen.getByTestId("user-row-oidc-provider")).toHaveTextContent(provider);
      expect(screen.getByTestId("user-row-role")).toHaveTextContent("Admin");
      const statuses = screen.getByTestId("user-metadata");
      expect(Array.from(statuses.children, (status) => status.textContent)).toEqual(["Disabled", "Expired", "Pwd change req'd"]);
      const created = screen.getByTestId("user-row-created");
      expect(
        within(created).getByText(new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(new Date(timestamp)))
      ).toBeInTheDocument();
      expect(
        within(created).getByText(new Intl.DateTimeFormat("de-DE", { timeStyle: "short" }).format(new Date(timestamp)))
      ).toBeInTheDocument();
      expect(created.querySelector("time")).toHaveAttribute("datetime", timestamp);
    } finally {
      await setRegionalLocalePreference("browser");
    }
  });

  it("reuses cached directory data when User Management remounts", async () => {
    const firstRender = render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await screen.findByText("admin (you)", { exact: true });
    firstRender.unmount();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await screen.findByText("admin (you)", { exact: true });
    expect(api.getUsers).toHaveBeenCalledTimes(1);
    expect(api.getCurrentUser).toHaveBeenCalledTimes(3);
    expect(api.getOidcConfiguration).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("progressbar", { name: "Updating user directory" })).not.toBeInTheDocument();
  });

  it("keeps directory rows visible and does not reload stable context while sorting", async () => {
    const restoreViewport = mockViewportWidth(1200);
    const user = userEvent.setup();
    let resolveSortedUsers: ((users: Awaited<ReturnType<typeof api.getUsers>>) => void) | undefined;

    vi.mocked(api.getUsers)
      .mockResolvedValueOnce(
        createMockAdminUserList([
          createMockAdminUser({
            id: "user-1",
            username: "admin",
            role: "admin",
            is_active: true,
            must_change_password: false,
            has_local_password: true,
            oidc_role_assignment: null,
            oidc: null,
            pending_oidc: null,
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
          }),
        ])
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSortedUsers = resolve;
          })
      );

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await screen.findByText("admin (you)", { exact: true });
      await user.click(within(screen.getByTestId("user-directory-header")).getByRole("button", { name: "Sort by Role" }));

      expect(screen.getByText("admin (you)", { exact: true })).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "Updating user directory" })).toBeInTheDocument();
      expect(api.getCurrentUser).toHaveBeenCalledTimes(2);
      expect(api.getOidcConfiguration).toHaveBeenCalledTimes(1);

      resolveSortedUsers?.(
        createMockAdminUserList([
          createMockAdminUser({
            id: "user-1",
            username: "admin",
            role: "admin",
            is_active: true,
            must_change_password: false,
            has_local_password: true,
            oidc_role_assignment: null,
            oidc: null,
            pending_oidc: null,
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
          }),
        ])
      );
      await waitFor(() => expect(api.getUsers).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole("progressbar", { name: "Updating user directory" })).not.toBeInTheDocument());
    } finally {
      restoreViewport();
    }
  });

  it("hides OIDC-only controls and clears OIDC query parameters when OIDC is disabled", async () => {
    const restoreViewport = mockViewportWidth(1200);
    window.history.replaceState(null, "", `${window.location.pathname}?auth=oidc&oidc_state=linked&role_source=oidc_groups`);
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "admin",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: null,
          oidc: { identity_id: "identity-1", provider_display_name: "Corporate login", last_login_at: null },
          pending_oidc: { expected_username: "admin", created_by_username: "admin", created_at: "2026-03-01T10:00:00Z" },
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    const user = userEvent.setup();

    try {
      render(
        <SambeeThemeProvider>
          <UserManagementSettings />
        </SambeeThemeProvider>
      );

      await screen.findByText("admin (you)", { exact: true });
      await user.click(await screen.findByRole("button", { name: "Filters" }));

      expect(screen.queryByRole("combobox", { name: "OIDC state" })).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Role source" })).not.toBeInTheDocument();
      expect(screen.queryByText("Last OIDC sign-in", { exact: true })).not.toBeInTheDocument();
      expect(screen.queryByText(/OIDC setup pending/)).not.toBeInTheDocument();
      expect(testRouter.state.location.search).not.toContain("auth=oidc");
      expect(testRouter.state.location.search).not.toContain("oidc_state");
      expect(testRouter.state.location.search).not.toContain("role_source");

      await user.keyboard("{Escape}");
      await openUserActions(user, "admin");
      expect(screen.queryByRole("menuitem", { name: /oidc/i })).not.toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });

  it("groups filters behind one control and exposes applied filters as removable chips", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await user.click(await screen.findByRole("button", { name: "Filters" }));
    expect(screen.getByText("Account", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("Sign-in", { exact: true }).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("combobox", { name: "Role" }));
    await user.click(screen.getByRole("option", { name: /Admin/ }));

    expect(await screen.findByText("Role: Admin", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters (1)", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Role: Admin", hidden: true })).toHaveAttribute("tabindex", "-1");
  });

  it("uses wrapped compact exception-status chips", async () => {
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    const activeChip = await screen.findByText("Active", { exact: true });
    const chipRow = activeChip.closest(".MuiStack-root");

    expect(chipRow).toHaveStyle({ display: "flex" });
  });

  it("keeps compact metadata and actions within each directory row", async () => {
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    const userRow = await screen.findByTestId("user-row");
    const metadata = screen.getByTestId("user-metadata");
    const actions = screen.getByTestId("user-row-actions");

    expect(userRow).toHaveStyle({ display: "grid" });
    expect(metadata).toHaveStyle({ flexWrap: "wrap" });
    expect(actions).toHaveStyle({ display: "flex" });
  });

  it("provides compact user actions through one overflow menu", async () => {
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await openUserActions(userEvent.setup(), "admin");

    expect(screen.queryByRole("menuitem", { name: /^edit user$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^reset password$/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^delete user$/i })).toHaveAttribute("aria-disabled", "true");
  });

  it("shows OIDC state and hides password reset for a passwordless account", async () => {
    mockOidcAuthenticationEnabled();
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "admin",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: null,
          oidc: {
            identity_id: "identity-1",
            provider_display_name: "Corporate login",
            last_login_at: "2026-03-01T10:00:00Z",
          },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-2",
          username: "second-oidc-user",
          role: "viewer",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: null,
          oidc: {
            identity_id: "identity-2",
            provider_display_name: "Corporate login",
            last_login_at: null,
          },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    expect((await screen.findAllByText("OIDC", { exact: true })).length).toBeGreaterThan(0);
    const lastSignIn = requireTestValue(screen.getAllByTestId("user-row-last-oidc-sign-in")[0]);
    expect(
      within(lastSignIn).getByText(new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(new Date("2026-03-01T10:00:00Z")))
    ).toBeInTheDocument();
    expect(
      within(lastSignIn).getByText(new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date("2026-03-01T10:00:00Z")))
    ).toBeInTheDocument();
    expect(lastSignIn.querySelector("time")).toHaveAttribute("datetime", "2026-03-01T10:00:00Z");
    expect(screen.getAllByText("second-oidc-user", { exact: true })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /reset password/i })).not.toBeInTheDocument();
  });

  it.each([
    ["oidc_only", "uniform"],
    ["oidc_or_password", "group_based"],
  ] as const)("renders directory identities in %s mode", async (authMode, roleAssignmentMode) => {
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "local-user",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-2",
          username: "inherited-user",
          role: "editor",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: null,
          oidc: { identity_id: "identity-2", provider_display_name: "Corporate login", last_login_at: null, inherited_role: "editor" },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-3",
          username: "override-user",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: "admin",
          oidc: { identity_id: "identity-3", provider_display_name: "Corporate login", last_login_at: null, inherited_role: "editor" },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-4",
          username: "pending-user",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: "admin",
          oidc: null,
          pending_oidc: {
            expected_username: "pending-user",
            created_by_username: "local-user",
            created_at: "2026-03-01T10:00:00Z",
          },
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-5",
          username: "unresolved-user",
          role: "editor",
          is_active: true,
          must_change_password: false,
          has_local_password: false,
          oidc_role_assignment: null,
          oidc: { identity_id: "identity-5", provider_display_name: "Corporate login", last_login_at: null, inherited_role: null },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    vi.mocked(api.getOidcConfiguration).mockResolvedValue({
      configuration: {
        no_refresh_session_limit_hours: 8,
        display_name: "Corporate login",
        issuer_url: "https://idp.example.test",
        client_id: "sambee",
        client_secret_configured: true,
        scopes: ["openid", "groups"],
        username_claim: "preferred_username",
        name_claim: "name",
        email_claim: "email",
        groups_claim: "groups",
        sign_in_mode: authMode,
        interactive_reauthentication_max_age_days: 30,
        admission_mode: "all_idp_users",
        admission_groups: [],
        role_assignment_mode: roleAssignmentMode,
        uniform_role: "editor",
        role_mappings: { admin: ["admins"], editor: ["editors"], viewer: ["viewers"] },
        auto_link_by_username: true,
        configuration_revision: 2,
        identity_mapping_revision: 1,
      },
      active_passwordless_user_count: 0,
      auth_mode: authMode,
      auth_enforcement_disabled: false,
      health: {
        public_url_configured: true,
        public_url: "https://sambee.example.test",
        redirect_uri: "https://sambee.example.test/api/auth/oidc/callback",
        status: "healthy",
        reasons: [],
      },
    });
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "user-1", username: "local-user", role: "admin" });

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    expect(await screen.findByText("local-user", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("inherited-user", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("override-user", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("pending-user", { exact: true }).length).toBeGreaterThan(0);
  });

  it("suppresses the user-load error when controlled OIDC reauthentication has started", async () => {
    vi.mocked(api.getUsers).mockRejectedValue(new Error("OIDC sign-in is required"));
    vi.mocked(isControlledReauthenticationInProgress).mockReturnValue(true);

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(isControlledReauthenticationInProgress).toHaveBeenCalled();
    });

    expect(screen.queryByText("Failed to load users")).not.toBeInTheDocument();
  });

  it("uses the centralized OIDC mapping dialog and closes change and move workflows with Escape", async () => {
    const restoreViewport = mockViewportWidth(1200);
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "linked-admin",
          role: "admin",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: {
            identity_id: "identity-1",
            user_id: "user-1",
            provider_display_name: "Corporate login",
            issuer: "https://idp.example.test",
            subject: "provider-subject-1",
            last_seen_username: "linked-admin",
            last_groups: ["admins", "operators"],
            created_at: "2026-03-01T10:00:00Z",
            last_login_at: null,
          },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-2",
          username: "unmapped-user",
          role: "viewer",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    vi.mocked(api.getOidcConfiguration).mockResolvedValue({
      configuration: {
        no_refresh_session_limit_hours: 8,
        display_name: "Corporate login",
        issuer_url: "https://idp.example.test",
        client_id: "sambee",
        client_secret_configured: true,
        scopes: ["openid", "groups"],
        username_claim: "preferred_username",
        name_claim: "name",
        email_claim: "email",
        groups_claim: "groups",
        sign_in_mode: "oidc_or_password",
        interactive_reauthentication_max_age_days: 30,
        admission_mode: "selected_groups",
        admission_groups: ["users"],
        role_assignment_mode: "uniform",
        uniform_role: "editor",
        role_mappings: { admin: ["admins"], editor: [], viewer: [] },
        auto_link_by_username: true,
        configuration_revision: 2,
        identity_mapping_revision: 1,
      },
      active_passwordless_user_count: 0,
      auth_mode: "oidc_or_password",
      auth_enforcement_disabled: false,
      health: {
        public_url_configured: true,
        public_url: "https://sambee.example.test",
        redirect_uri: "https://sambee.example.test/api/auth/oidc/callback",
        status: "healthy",
        reasons: [],
      },
    });
    vi.mocked(api.getCurrentUser).mockResolvedValue({
      id: "other-admin",
      username: "other-admin",
      role: "admin",
    });
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await openUserActions(user, "unmapped-user");
    expect(screen.getByRole("menuitem", { name: "Map OIDC account" })).toBeEnabled();
    await user.click(screen.getByRole("menuitem", { name: "Map OIDC account" }));
    const newExpectedUsername = await screen.findByLabelText("Expected provider username");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Provider username is required.")).toBeInTheDocument();
    expect(newExpectedUsername).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(newExpectedUsername, "unmapped-user");
    expect(newExpectedUsername).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("Provider username is required.")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Map OIDC account" })).not.toBeInTheDocument());
    vi.mocked(api.getUsers).mockResolvedValue({
      items: [
        {
          id: "user-2",
          username: "unmapped-user",
          role: "viewer",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      ],
      total: 1,
      summary: { total: 1, active_admins: 0, disabled: 0, expiring_soon: 0, pending_oidc: 0, unavailable_sign_in: 0 },
    });

    await openUserActions(user, "linked-admin");
    await user.click(screen.getByRole("menuitem", { name: "View OIDC identity details" }));
    const identityDetailsDialog = await screen.findByRole("dialog", { name: "OIDC identity details for linked-admin" });
    expect(identityDetailsDialog).toBeInTheDocument();
    const providerSubject = screen.getByLabelText("IdP subject");
    expect(screen.getByTestId("oidc-details-form-surface")).toContainElement(providerSubject);
    expect(providerSubject).toHaveValue("provider-subject-1");
    expect(providerSubject.closest(".MuiInputBase-root")).toHaveClass("MuiInputBase-sizeSmall");
    expect(providerSubject).toHaveAttribute("aria-describedby", "oidc-details-subject-description");
    const idpGroups = screen.getByLabelText("IdP groups");
    expect(idpGroups.tagName).toBe("TEXTAREA");
    expect(idpGroups).toHaveValue("admins\noperators");
    expect(screen.getByText("Linked in Sambee")).not.toHaveClass("MuiInputLabel-root");
    expect(screen.getByText("When Sambee first linked this IdP identity to the account")).not.toHaveClass("MuiFormHelperText-root");
    expect(screen.queryByText("Sambee OIDC identity record ID")).not.toBeInTheDocument();
    expect(screen.queryByText("Sambee local user ID")).not.toBeInTheDocument();
    expect(screen.queryByText("Stored identity properties for linked-admin.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "OIDC identity details" })).not.toBeInTheDocument());

    await openUserActions(user, "linked-admin");
    expect(screen.getByRole("menuitem", { name: "Change OIDC account" })).toBeEnabled();
    await user.click(screen.getByRole("menuitem", { name: "Change OIDC account" }));
    const expectedUsername = await screen.findByLabelText("Expected provider username");
    expect(expectedUsername).toHaveFocus();
    expect(screen.getByTestId("oidc-mapping-editor-form-surface")).toContainElement(expectedUsername);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("oidc-mapping-contextual-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("oidc-mapping-action-error")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await openUserActions(user, "linked-admin");
    await user.click(screen.getByRole("menuitem", { name: "Move identity to another local user" }));
    const targetAccount = await screen.findByLabelText("Move identity to");
    expect(targetAccount).toHaveFocus();
    expect(screen.getByTestId("oidc-mapping-editor-form-surface")).toContainElement(targetAccount);
    expect(screen.getByText("Search eligible active, unlinked local accounts by username, name, or email")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.getUsers).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 100,
        q: undefined,
        states: ["active"],
        oidcStates: ["unlinked"],
      })
    );
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Select an available local account.")).toBeInTheDocument();
    expect(targetAccount).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(targetAccount);
    expect(await screen.findByRole("option", { name: "unmapped-user" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(targetAccount).toHaveValue("unmapped-user");
    expect(targetAccount).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.moveOidcIdentity).not.toHaveBeenCalled();
    vi.mocked(api.moveOidcIdentity).mockRejectedValueOnce({ response: { data: { detail: "OIDC mapping rejected." } } });
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    const mappingActionError = await screen.findByTestId("oidc-mapping-action-error");
    expect(mappingActionError).toHaveTextContent("OIDC mapping rejected.");
    expect(mappingActionError).toHaveAttribute("role", "alert");
    expect(
      mappingActionError.compareDocumentPosition(screen.getByTestId("responsive-form-dialog-desktop-actions")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.moveOidcIdentity).toHaveBeenCalledWith("identity-1", 1, "user-2"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    restoreViewport();
  });

  it.each([
    {
      action: "Cancel pending OIDC mapping",
      username: "pending-user",
      method: "cancelPendingOidcMapping",
      warning: "Cancel the pending OIDC mapping for pending-user?",
    },
    {
      action: "Detach OIDC identity",
      username: "linked-user",
      method: "detachOidcIdentity",
      warning: "Detach the OIDC identity from linked-user? This does not revoke IdP access.",
    },
  ] as const)("confirms $action only after explicit acceptance", async ({ action, username, method, warning }) => {
    const restoreViewport = mockViewportWidth(1200);
    vi.mocked(api.getUsers).mockResolvedValue(
      createMockAdminUserList([
        createMockAdminUser({
          id: "user-1",
          username: "pending-user",
          role: "editor",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: null,
          pending_oidc: { expected_username: "pending-user", created_by_username: "admin", created_at: "2026-03-01T10:00:00Z" },
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
        createMockAdminUser({
          id: "user-2",
          username: "linked-user",
          role: "editor",
          is_active: true,
          must_change_password: false,
          has_local_password: true,
          oidc_role_assignment: null,
          oidc: { identity_id: "identity-2", provider_display_name: "Corporate login", last_login_at: null },
          pending_oidc: null,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        }),
      ])
    );
    vi.mocked(api.getOidcConfiguration).mockResolvedValue({
      configuration: {
        no_refresh_session_limit_hours: 8,
        display_name: "Corporate login",
        issuer_url: "https://idp.example.test",
        client_id: "sambee",
        client_secret_configured: true,
        scopes: ["openid"],
        username_claim: "preferred_username",
        name_claim: "name",
        email_claim: "email",
        groups_claim: "groups",
        sign_in_mode: "oidc_or_password",
        interactive_reauthentication_max_age_days: 30,
        admission_mode: "all_idp_users",
        admission_groups: [],
        role_assignment_mode: "uniform",
        uniform_role: "editor",
        role_mappings: { admin: [], editor: [], viewer: [] },
        auto_link_by_username: true,
        configuration_revision: 2,
        identity_mapping_revision: 1,
      },
      active_passwordless_user_count: 0,
      auth_mode: "oidc_or_password",
      auth_enforcement_disabled: false,
      health: { status: "healthy", public_url_configured: false, public_url: null, redirect_uri: null, reasons: [] },
    });
    vi.mocked(api[method]).mockResolvedValue({ identity_mapping_revision: 1, pending_mappings: [] });
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    const openConfirmation = async () => {
      await openUserActions(user, username);
      await user.click(screen.getByRole("menuitem", { name: action }));
      return screen.findByRole("dialog", { name: `${action}?` });
    };

    let dialog = await openConfirmation();
    expect(within(dialog).getByText(warning)).toBeInTheDocument();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(cancel).toHaveClass("MuiButton-outlined");
    expect(within(dialog).getByRole("button", { name: action })).toHaveClass("MuiButton-contained", "MuiButton-colorError");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: `${action}?` })).not.toBeInTheDocument());
    expect(api[method]).not.toHaveBeenCalled();

    dialog = await openConfirmation();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: `${action}?` })).not.toBeInTheDocument());
    expect(api[method]).not.toHaveBeenCalled();

    dialog = await openConfirmation();
    await user.click(within(dialog).getByRole("button", { name: action }));
    await waitFor(() => expect(api[method]).toHaveBeenCalledOnce());
    expect(api[method]).toHaveBeenCalledWith(username === "pending-user" ? "user-1" : "user-2", 1);
    restoreViewport();
  });

  it("lets the admin enter a new password for a reset", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(api.getUsers).toHaveBeenCalled();
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    await openUserActions(user, "admin");
    await user.click(screen.getByRole("menuitem", { name: /reset password/i }));

    const passwordInput = await screen.findByLabelText(/^new password$/i);
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(screen.getByText("Choose the password the user should use at next sign-in")).toHaveClass("MuiFormHelperText-root");

    await user.click(screen.getByRole("button", { name: /show new password/i }));
    expect(passwordInput).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: /hide new password/i })).toBeInTheDocument();

    await user.type(passwordInput, "BrandNewPass123!");
    expect(screen.getByText("On")).toBeInTheDocument();
    await user.click(screen.getByLabelText(/require change on next password sign-in/i));
    expect(screen.getByText("Off")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => {
      expect(api.resetUserPassword).toHaveBeenCalledWith("user-1", {
        new_password: "BrandNewPass123!",
        must_change_password: false,
      });
    });

    await waitFor(() => {
      expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
    });
  });

  it("uses the centralized reset-password dialog and closes it with Escape", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await openUserActions(user, "admin");
    await user.click(screen.getByRole("menuitem", { name: /reset password/i }));

    const passwordInput = await screen.findByLabelText(/^new password$/i);
    expect(passwordInput).toHaveFocus();
    expect(screen.getByTestId("reset-password-editor-form-surface")).toContainElement(passwordInput);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set password/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("disables reset-password editor actions while the request is pending", async () => {
    const user = userEvent.setup();
    let resolveReset!: (value: AdminUserPasswordResetResult) => void;
    vi.mocked(api.resetUserPassword).mockReturnValue(
      new Promise<AdminUserPasswordResetResult>((resolve) => {
        resolveReset = resolve;
      })
    );

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(api.getUsers).toHaveBeenCalled();
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    await openUserActions(user, "admin");
    await user.click(screen.getByRole("menuitem", { name: /reset password/i }));
    await user.type(await screen.findByLabelText(/^new password$/i), "BrandNewPass123!");
    await user.click(await screen.findByRole("button", { name: /set password/i }));

    await waitFor(() => {
      expect(api.resetUserPassword).toHaveBeenCalledWith("user-1", {
        new_password: "BrandNewPass123!",
        must_change_password: true,
      });
    });

    expect(screen.getByRole("button", { name: /set password/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    resolveReset({
      message: "Password reset",
    });

    await waitFor(() => {
      expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
    });
  });

  it("keeps the create-user label visible while the save request is pending", async () => {
    const user = userEvent.setup();
    let resolveCreateUser!: (value: AdminUserCreateResult) => void;
    vi.mocked(api.createUser).mockReturnValue(
      new Promise<AdminUserCreateResult>((resolve) => {
        resolveCreateUser = resolve;
      })
    );

    render(
      <SambeeThemeProvider>
        <UserManagementSettings />
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(api.getUsers).toHaveBeenCalled();
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: /add user/i }));
    await user.type(await screen.findByLabelText(/username/i), "new-admin");

    await user.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() => {
      expect(api.createUser).toHaveBeenCalledWith({
        username: "new-admin",
        name: undefined,
        email: undefined,
        role: "editor",
        must_change_password: true,
        password: undefined,
        expires_at: undefined,
      });
    });

    expect(screen.getByRole("button", { name: /create user/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /create user/i })).toHaveTextContent(/create user/i);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    await act(async () => {
      resolveCreateUser({
        id: "user-2",
        username: "new-admin",
        role: "editor",
        is_active: true,
        must_change_password: true,
        has_local_password: true,
        oidc_role_assignment: null,
        oidc: null,
        pending_oidc: null,
        created_at: "2026-03-01T10:00:00Z",
        updated_at: "2026-03-01T10:00:00Z",
        temporary_password: null,
      });
    });
  });
});
