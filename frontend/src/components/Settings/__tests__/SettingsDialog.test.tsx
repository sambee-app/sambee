import { Dialog } from "@mui/material";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SambeeThemeProvider } from "../../../theme";
import { SettingsCategoryContent } from "../SettingsCategoryContent";
import SettingsDialog from "../SettingsDialog";
import type { SettingsCategory } from "../settingsCategories";
import { scheduleSettingsPagePrefetch } from "../settingsPageLoaders";

const networkModule = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { ready, resolve, load: vi.fn() };
});

vi.mock("../../../pages/NetworkSettings", async () => {
  networkModule.load();
  await networkModule.ready;
  return { NetworkSettings: () => <div>Network Settings Content</div> };
});

vi.mock("../settingsDataSources", () => ({
  prefetchSettingsDataForItems: vi.fn(),
}));

vi.mock("../settingsPageLoaders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settingsPageLoaders")>()),
  scheduleSettingsPagePrefetch: vi.fn(),
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
    expect(await screen.findByText("Appearance Settings Content")).toBeInTheDocument();
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

    expect(await screen.findByText("Connections Settings Content")).toBeInTheDocument();
  });

  it("renders Account settings when selected", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await user.click(await screen.findByRole("option", { name: /^account$/i }));

    expect(await screen.findByText("Account Settings Content")).toBeInTheDocument();
  });

  it("renders Authentication settings when selected", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await user.click(await screen.findByRole("option", { name: /^authentication$/i }));

    const authenticationContent = await screen.findByText("Authentication Settings Content");
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

    expect(await screen.findByText("File Browser Settings Content")).toBeInTheDocument();
  });

  it("switches to Local Drives when its top-level settings item is clicked", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    const localDrivesOption = screen.getByRole("option", { name: /local drives/i });
    await user.click(localDrivesOption);

    expect(await screen.findByText("Local Drives Settings Content")).toBeInTheDocument();
  });

  it("opens the requested consolidated initial category", async () => {
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} initialCategory="connections" />);

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    expect(await screen.findByText("Connections Settings Content")).toBeInTheDocument();
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

  it("keeps initial category focus when Strict Mode replays modal effects", async () => {
    renderWithTheme(
      <StrictMode>
        <SettingsDialog open={true} onClose={mockOnClose} initialCategory="connections" />
      </StrictMode>
    );

    expect(await screen.findByText("Connections Settings Content")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^connections$/i })).toHaveFocus();
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

    expect(await screen.findByText("Appearance Settings Content")).toBeInTheDocument();
  });

  it("switches to Connections when a regular user clicks it", async () => {
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    // Wait for user status to load
    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
    });

    expect(await screen.findByText("Appearance Settings Content")).toBeInTheDocument();

    const connectionsOption = screen.getByRole("option", { name: /^connections$/i });
    await user.click(connectionsOption);

    expect(await screen.findByText("Connections Settings Content")).toBeInTheDocument();
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

    expect(await screen.findByText("User Management Settings Content")).toBeInTheDocument();
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

    expect(await screen.findByText("System Settings Content")).toBeInTheDocument();
  });

  it("switches to About when an admin clicks it", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    await user.click(await screen.findByRole("option", { name: /^about$/i }));

    expect(await screen.findByText("About Settings Content")).toBeInTheDocument();
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

    expect(await screen.findByText("Local Drives Settings Content")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /local drives/i })).toHaveFocus();

    await user.keyboard("{Home}");

    expect(await screen.findByText("Appearance Settings Content")).toBeInTheDocument();
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

    expect(await screen.findByText("About Settings Content")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^about$/i })).toHaveFocus();

    await user.keyboard("{PageUp}");

    expect(await screen.findByText("Appearance Settings Content")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /appearance/i })).toHaveFocus();
  });

  it("prefetches only permitted categories after the selected page renders, during idle time", async () => {
    const cancel = vi.fn();
    vi.mocked(scheduleSettingsPagePrefetch).mockReturnValueOnce(cancel);
    const { unmount } = renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);
    await screen.findByText("Appearance Settings Content");
    expect(scheduleSettingsPagePrefetch).toHaveBeenCalledOnce();
    expect(scheduleSettingsPagePrefetch).toHaveBeenCalledWith(["account", "file-browser", "text-editor", "connections", "local-drives"]);
    unmount();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not load an admin-only category for a non-admin user", () => {
    renderWithTheme(<SettingsCategoryContent item="admin-network" isAdmin={false} />);

    expect(networkModule.load).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Network Settings Content")).not.toBeInTheDocument();
  });

  it("keeps navigation available during category loading and ignores a late module after leaving", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({ id: "admin-id", username: "admin", role: "admin" });
    const user = userEvent.setup();
    renderWithTheme(<SettingsDialog open={true} onClose={mockOnClose} />);

    const networkOption = await screen.findByRole("option", { name: /^network$/i });
    await user.click(networkOption);

    expect(networkModule.load).toHaveBeenCalledOnce();
    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
    expect(networkOption).toHaveFocus();
    expect(screen.getByRole("dialog")).toBeVisible();

    const accountOption = screen.getByRole("option", { name: /^account$/i });
    await user.click(accountOption);
    expect(await screen.findByText("Account Settings Content")).toBeInTheDocument();

    await act(async () => networkModule.resolve());
    expect(screen.queryByText("Network Settings Content")).not.toBeInTheDocument();
    expect(accountOption).toHaveFocus();

    await user.click(networkOption);
    expect(await screen.findByText("Network Settings Content")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /loading/i })).not.toBeInTheDocument();
    expect(networkModule.load).toHaveBeenCalledOnce();
  });
});
