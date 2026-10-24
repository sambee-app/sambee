import { createTheme } from "@mui/material";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { requireTestValue } from "../../../test/helpers/assertions";
import "../../../i18n";
import HamburgerMenu from "../../../components/Mobile/HamburgerMenu";
import { mobileNavigationDrawerTypographySx } from "../../../theme/mobileShell";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import type { Connection } from "../../../types";
import { fetchVersionInfo } from "../../../utils/version";

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the version utility module
vi.mock("../../../utils/version", () => ({
  fetchVersionInfo: vi.fn(() => Promise.resolve({ version: "0.1.0", build_time: "2024-01-01T00:00:00Z", git_commit: "abc1234" })),
  formatBuildTime: vi.fn(() => "Jan 1, 2024, 12:00 AM"),
}));

// Mock data
const mockConnections: Connection[] = [
  {
    id: "1",
    name: "Test Share",
    type: "smb",
    slug: "test-share",
    scope: "private",
    access_mode: "read_write",
    can_manage: true,
    host: "server.local",
    port: 445,
    share_name: "share1",
    username: "testuser",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "2",
    name: "Another Share",
    type: "smb",
    slug: "another-share",
    scope: "private",
    access_mode: "read_write",
    can_manage: true,
    host: "server2.local",
    port: 445,
    share_name: "share2",
    username: "testuser",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
];

describe("HamburgerMenu", () => {
  const mockOnClose = vi.fn();
  const mockOnConnectionChange = vi.fn();
  const mockOnNavigateToRoot = vi.fn();
  const mockOnOpenDocumentation = vi.fn();
  const mockOnOpenSettings = vi.fn();
  const mockOnLogout = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders menu when open", () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    expect(screen.getByText("Sambee")).toBeInTheDocument();
    expect(screen.getByText("Root")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Documentation")).toBeInTheDocument();
    expect(screen.getByText("Logout")).toBeInTheDocument();

    const menuItems = screen.getAllByRole("button");
    const settingsIndex = menuItems.findIndex((item) => item.textContent?.includes("Settings"));
    const documentationIndex = menuItems.findIndex((item) => item.textContent?.includes("Documentation"));
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(documentationIndex).toBeGreaterThan(settingsIndex);
  });

  test("uses the compact typography scale for drawer labels and connection values", () => {
    const theme = createTheme();
    if (typeof mobileNavigationDrawerTypographySx !== "function") {
      throw new Error("Main drawer typography must remain theme-aware.");
    }

    const styles = requireTestValue(mobileNavigationDrawerTypographySx(theme));
    expect(styles[theme.breakpoints.down("sm")]).toMatchObject({
      "& .MuiTypography-h6": { fontSize: "20px" },
      "& .MuiListItemText-primary, & .MuiInputBase-input, & .MuiSelect-select": { fontSize: "17px" },
    });
  });

  test("does not fetch or display version information", () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    expect(fetchVersionInfo).not.toHaveBeenCalled();
    expect(screen.queryByText("Version: 0.1.0")).not.toBeInTheDocument();
    expect(screen.queryByText("Build: 2024-01-01T00:00:00Z")).not.toBeInTheDocument();
  });

  test("does not render when closed", () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={false}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    expect(screen.queryByText("Sambee")).not.toBeInTheDocument();
  });

  test("shows connection selector with connections", () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    expect(screen.getByText("Connection")).toHaveStyle({ fontSize: "14px" });
    // The Select dropdown renders the connection names - verify connections are available
    // by checking for the select input
    const selectInputs = screen.getAllByRole("combobox");
    expect(selectInputs.length).toBeGreaterThan(0);
  });

  test("calls onNavigateToRoot when Root is clicked", async () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    const rootButton = screen.getByText("Root");
    fireEvent.click(rootButton);

    await waitFor(() => {
      expect(mockOnNavigateToRoot).toHaveBeenCalledTimes(1);
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  test("calls onOpenSettings when Settings is clicked", async () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    const settingsButton = screen.getByText("Settings");
    fireEvent.click(settingsButton);

    await waitFor(() => {
      expect(mockOnOpenSettings).toHaveBeenCalledTimes(1);
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  test("calls onOpenDocumentation when Documentation is clicked", async () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    fireEvent.click(screen.getByText("Documentation"));

    await waitFor(() => {
      expect(mockOnOpenDocumentation).toHaveBeenCalledTimes(1);
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  test("calls onLogout when Logout is clicked", async () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    const logoutButton = screen.getByText("Logout");
    fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(mockOnLogout).toHaveBeenCalledTimes(1);
    });
  });

  test("shows Settings for all users", () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    expect(screen.getByText("Documentation")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Root")).toBeInTheDocument();
    expect(screen.getByText("Logout")).toBeInTheDocument();
  });

  test("connection selector is present with connections", () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={mockConnections}
            selectedConnectionId="1"
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    // Connection label should be visible
    expect(screen.getByText("Connection")).toBeInTheDocument();

    // The current connection name should be displayed
    expect(screen.getByText(/Test Share/)).toBeInTheDocument();
  });

  test("handles empty connections list", () => {
    render(
      <SambeeThemeProvider>
        <BrowserRouter>
          <HamburgerMenu
            open={true}
            onClose={mockOnClose}
            connections={[]}
            selectedConnectionId=""
            onConnectionChange={mockOnConnectionChange}
            onNavigateToRoot={mockOnNavigateToRoot}
            onOpenDocumentation={mockOnOpenDocumentation}
            onOpenSettings={mockOnOpenSettings}
            onLogout={mockOnLogout}
          />
        </BrowserRouter>
      </SambeeThemeProvider>
    );

    // Connection selector should not be visible
    expect(screen.queryByText("Connection")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    // But other menu items should still be there
    expect(screen.getByText("Root")).toBeInTheDocument();
    expect(screen.getByText("Documentation")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Logout")).toBeInTheDocument();
  });
});
