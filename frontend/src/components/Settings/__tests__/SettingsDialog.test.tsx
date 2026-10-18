import { Dialog } from "@mui/material";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SambeeThemeProvider } from "../../../theme";
import SettingsDialog from "../SettingsDialog";
import type { SettingsCategory } from "../settingsCategories";

vi.mock("../settingsDataSources", () => ({
  prefetchSettingsDataForItems: vi.fn(),
}));

// Mock the API module
vi.mock("../../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: vi.fn(),
  },
}));

// Mock the consolidated settings pages since they're rendered by the dialog
vi.mock("../../../pages/PreferencesSettings", () => ({
  AppearanceSettings: () => (
    <div>
      Appearance Settings Content
      <input aria-label="Appearance preference" />
    </div>
  ),
}));

vi.mock("../../../pages/AccountSettings", () => ({
  AccountSettings: () => <div>Account Settings Content</div>,
}));

vi.mock("../../../pages/ConnectionsSettings", () => ({
  ConnectionsSettings: () => <div>Connections Settings Content</div>,
}));

vi.mock("../../../pages/FileBrowserSettings", () => ({
  FileBrowserSettings: () => <div>File Browser Settings Content</div>,
}));

vi.mock("../../../pages/TextEditorSettings", () => ({
  TextEditorSettings: () => <div>Text Editor Settings Content</div>,
}));

vi.mock("../../../pages/LocalDrivesSettings", () => ({
  LocalDrivesSettings: () => <div>Local Drives Settings Content</div>,
}));

vi.mock("../../../pages/AuthenticationSettings", () => ({
  AuthenticationSettings: () => <div>Authentication Settings Content</div>,
}));

vi.mock("../../../pages/UserManagementSettings", () => ({
  UserManagementSettings: () => <div>User Management Settings Content</div>,
}));

vi.mock("../../../pages/AdvancedSettings", () => ({
  AdvancedSettings: () => <div>System Settings Content</div>,
}));

vi.mock("../../../pages/AboutSettings", () => ({
  AboutSettings: () => <div>About Settings Content</div>,
}));

import api from "../../../services/api";

describe("SettingsDialog Component", () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock getCurrentUser to return non-admin user by default
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "user-id", username: "testuser", role: "editor" });
  });

  const renderWithTheme = (ui: React.ReactElement) => {
    return render(<SambeeThemeProvider>{ui}</SambeeThemeProvider>);
  };

  it("does not check user status when dialog is closed", () => {
    renderWithTheme(<SettingsDialog open={false} onClose={mockOnClose} />);

    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("checks user status and displays appearance settings when opened", async () => {
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    // Dialog should check user status
    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    // Should show Appearance by default
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByText("Appearance Settings Content")).toBeInTheDocument();
  });

  it("uses an explicitly sized paper instead of MUI fullWidth mode", async () => {
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    const dialog = await screen.findByRole("dialog");

    expect(dialog).not.toHaveClass("MuiDialog-paperFullWidth");
  });

  it("closes dialog when close button is clicked", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText("Appearance")).toBeInTheDocument();
    });

    // Click close button (icon button with CloseIcon)
    const closeIcon = screen.getByTestId("CloseIcon");
    const closeButton = closeIcon.closest("button");
    if (closeButton) {
      await user.click(closeButton);
    }

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("shows the consolidated settings categories for admin users", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });

    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    // Wait for user status to load
    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    // Should show all categories in sidebar
    expect(screen.getByText("Settings")).toBeInTheDocument();
    const appearanceOption = await screen.findByRole("option", { name: /appearance/i });
    const fileBrowserOption = screen.getByRole("option", { name: /file browser/i });
    const textEditorOption = screen.getByRole("option", { name: /text editor/i });
    const connectionsOption = screen.getByRole("option", { name: /^connections$/i });
    const authenticationOption = await screen.findByRole("option", { name: /^authentication$/i });
    const userManagementOption = await screen.findByRole("option", { name: /user management/i });
    const systemOption = await screen.findByRole("option", { name: /system/i });
    const aboutOption = await screen.findByRole("option", { name: /^about$/i });

    expect(appearanceOption).toBeInTheDocument();
    expect(fileBrowserOption).toBeInTheDocument();
    expect(textEditorOption).toBeInTheDocument();
    expect(connectionsOption).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /local drives/i })).toBeInTheDocument();
    expect(authenticationOption).toBeInTheDocument();
    expect(authenticationOption.querySelector("svg")).toBeInTheDocument();
    expect(userManagementOption).toBeInTheDocument();
    expect(systemOption).toBeInTheDocument();
    expect(aboutOption).toBeInTheDocument();
    expect(aboutOption.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByText("Administration")).toBeInTheDocument();
  });

  it("shows only personal consolidated categories for non-admin users", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "user-id", username: "user", role: "editor" });

    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    // Wait for user status to load
    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /appearance/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /file browser/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^connections$/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /local drives/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /user management/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /system/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^about$/i })).not.toBeInTheDocument();
  });

  it("switches to Connections when clicked", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    const connectionsOption = screen.getByRole("option", { name: /^connections$/i });
    await user.click(connectionsOption);

    expect(screen.getByText("Connections Settings Content")).toBeInTheDocument();
  });

  it("renders Account settings when selected", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await user.click(await screen.findByRole("option", { name: /^account$/i }));

    expect(screen.getByText("Account Settings Content")).toBeInTheDocument();
  });

  it("renders Authentication settings when selected", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await user.click(await screen.findByRole("option", { name: /^authentication$/i }));

    const authenticationContent = screen.getByText("Authentication Settings Content");
    expect(authenticationContent).toBeInTheDocument();
  });

  it("switches to File Browser when clicked", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    const fileBrowserOption = screen.getByRole("option", { name: /file browser/i });
    await user.click(fileBrowserOption);

    expect(screen.getByText("File Browser Settings Content")).toBeInTheDocument();
  });

  it("switches to Local Drives when its top-level settings item is clicked", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    const localDrivesOption = screen.getByRole("option", { name: /local drives/i });
    await user.click(localDrivesOption);

    expect(screen.getByText("Local Drives Settings Content")).toBeInTheDocument();
  });

  it("opens the requested consolidated initial category", async () => {
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} initialCategory="connections" />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    expect(screen.getByText("Connections Settings Content")).toBeInTheDocument();
  });

  it("focuses the initial category on each opening", async () => {
    const { rerender } = renderWithTheme(<SettingsDialog open={false} onClose={mockOnClose} initialCategory="connections" />);
    rerender(
      <SambeeThemeProvider>
        <SettingsDialog open={true} onClose={mockOnClose} initialCategory="connections" />
      </SambeeThemeProvider>
    );
    expect(await screen.findByRole("option", { name: /^connections$/i })).toHaveFocus();
    rerender(
      <SambeeThemeProvider>
        <SettingsDialog open={false} onClose={mockOnClose} initialCategory="connections" />
      </SambeeThemeProvider>
    );
    rerender(
      <SambeeThemeProvider>
        <SettingsDialog open={true} onClose={mockOnClose} initialCategory="account" />
      </SambeeThemeProvider>
    );
    expect(await screen.findByRole("option", { name: /^account$/i })).toHaveFocus();
  });

  it("synchronizes controlled category focus without waiting for a timer", async () => {
    const { rerender } = renderWithTheme(
      <SettingsDialog open={true} onClose={mockOnClose} initialCategory="connections" category="connections" />
    );
    expect(await screen.findByRole("option", { name: /^connections$/i })).toHaveFocus();
    for (const category of ["account", "appearance", "connections"] as const) {
      rerender(
        <SambeeThemeProvider>
          <SettingsDialog open={true} onClose={mockOnClose} initialCategory={category} category={category} />
        </SambeeThemeProvider>
      );
      expect(screen.getByRole("option", { name: new RegExp(`^${category}$`, "i") })).toHaveFocus();
    }
  });

  it("keeps category focus aligned through Back, Forward, and rapid history navigation", async () => {
    function RoutedSettingsDialog() {
      const location = useLocation();
      const navigate = useNavigate();
      const category = new URLSearchParams(location.search).get("settings") as SettingsCategory;
      return (
        <SettingsDialog
          open={true}
          onClose={mockOnClose}
          initialCategory={category}
          category={category}
          onNavigate={(next) => void navigate({ search: `?settings=${next}` }, { flushSync: true })}
        />
      );
    }
    const router = createMemoryRouter([{ path: "/settings-test", element: <RoutedSettingsDialog /> }], {
      initialEntries: ["/settings-test?settings=appearance", "/settings-test?settings=account", "/settings-test?settings=connections"],
    });
    renderWithTheme(<RouterProvider router={router} />);
    expect(await screen.findByRole("option", { name: /^connections$/i })).toHaveFocus();
    await act(() => router.navigate(-1));
    expect(screen.getByRole("option", { name: /^account$/i })).toHaveFocus();
    await act(() => router.navigate(1));
    expect(screen.getByRole("option", { name: /^connections$/i })).toHaveFocus();
    await act(() => {
      void router.navigate(-1);
      void router.navigate(-1);
    });
    expect(screen.getByRole("option", { name: /^appearance$/i })).toHaveFocus();
  });

  it("preserves form focus when available categories change after permissions load", async () => {
    let resolveUser!: (user: Awaited<ReturnType<typeof api.getCurrentUser>>) => void;
    vi.mocked(api.getCurrentUser).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUser = resolve;
      })
    );
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);
    const input = await screen.findByRole("textbox", { name: "Appearance preference" });
    input.focus();
    await act(async () => resolveUser({ id: "admin-id", username: "admin", role: "admin" }));
    await screen.findByRole("option", { name: /^about$/i });
    expect(input).toHaveFocus();
  });

  it("does not steal focus from a nested dialog during category changes", async () => {
    const renderDialogs = (category: SettingsCategory, nestedOpen: boolean) => (
      <SambeeThemeProvider>
        <SettingsDialog open={true} onClose={mockOnClose} initialCategory={category} category={category} />
        <Dialog open={nestedOpen} aria-label="Nested settings dialog">
          <input autoFocus aria-label="Nested preference" />
        </Dialog>
      </SambeeThemeProvider>
    );
    const { rerender } = render(renderDialogs("connections", false));
    expect(await screen.findByRole("option", { name: /^connections$/i })).toHaveFocus();
    const account = screen.getByRole("option", { name: /^account$/i });
    rerender(renderDialogs("connections", true));
    const input = await screen.findByRole("textbox", { name: "Nested preference" });
    expect(input).toHaveFocus();
    const focusCategory = vi.spyOn(account, "focus");
    rerender(renderDialogs("account", true));
    expect(focusCategory).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    focusCategory.mockRestore();
  });

  it("falls back to Appearance when an admin-only initial category is unavailable", async () => {
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} initialCategory="admin-users" />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    expect(screen.getByText("Appearance Settings Content")).toBeInTheDocument();
  });

  it("switches to Connections when a regular user clicks it", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    // Wait for user status to load
    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    expect(screen.getByText("Appearance Settings Content")).toBeInTheDocument();

    const connectionsOption = screen.getByRole("option", { name: /^connections$/i });
    await user.click(connectionsOption);

    expect(screen.getByText("Connections Settings Content")).toBeInTheDocument();
  });

  it("switches to User Management tab when admin clicks it", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });

    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    const userManagementOption = await screen.findByRole("option", { name: /user management/i });
    await user.click(userManagementOption);

    expect(screen.getByText("User Management Settings Content")).toBeInTheDocument();
  });

  it("switches to System when admin clicks it", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });

    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    const systemOption = await screen.findByRole("option", { name: /system/i });
    await user.click(systemOption);

    expect(screen.getByText("System Settings Content")).toBeInTheDocument();
  });

  it("switches to About when an admin clicks it", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await user.click(await screen.findByRole("option", { name: /^about$/i }));

    expect(screen.getByText("About Settings Content")).toBeInTheDocument();
  });

  it("supports Home and End keyboard navigation in the category list", async () => {
    const user = userEvent.setup();

    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    const connectionsOption = screen.getByRole("option", { name: /^connections$/i });
    connectionsOption.focus();

    await user.keyboard("{End}");

    expect(screen.getByText("Local Drives Settings Content")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /local drives/i })).toHaveFocus();

    await user.keyboard("{Home}");

    expect(screen.getByText("Appearance Settings Content")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /appearance/i })).toHaveFocus();
  });

  it("supports PageUp and PageDown keyboard navigation in the category list", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });
    const user = userEvent.setup();

    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    await screen.findByRole("option", { name: /system/i });

    const appearanceOption = screen.getByRole("option", { name: /appearance/i });
    appearanceOption.focus();

    await user.keyboard("{PageDown}");

    expect(screen.getByText("About Settings Content")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^about$/i })).toHaveFocus();

    await user.keyboard("{PageUp}");

    expect(screen.getByText("Appearance Settings Content")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /appearance/i })).toHaveFocus();
  });
});
