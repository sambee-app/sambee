import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import { createMockConnection } from "../../test/fixtures/connections";
import { requireTestValue } from "../../test/helpers/assertions";
import { SambeeThemeProvider } from "../../theme";
import { ConnectionSettings } from "../ConnectionSettings";

vi.mock("../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: vi.fn(),
    getConnections: vi.fn(),
    getConnectionVisibilityOptions: vi.fn(),
    deleteConnection: vi.fn(),
    testConnection: vi.fn(),
    createConnection: vi.fn(),
    updateConnection: vi.fn(),
    testConnectionConfig: vi.fn(),
  },
}));

import api from "../../services/api";

function mockMobileMode(isMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isMobile ? !query.includes("min-width") : query.includes("min-width"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const mockVisibilityOptions = [
  {
    value: "private" as const,
    label: "Private to me",
    description: "Visible only to your account. You can fully manage it.",
    available: true,
    unavailable_reason: null,
  },
  {
    value: "shared" as const,
    label: "Shared with everyone",
    description: "Visible to all users. Only admins can manage it.",
    available: true,
    unavailable_reason: null,
  },
];

describe("ConnectionSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMobileMode(false);
    clearCachedAsyncData();
    vi.mocked(api.getCurrentUser).mockResolvedValue({
      id: "admin-id",
      username: "admin",
      role: "admin",
    });
    vi.mocked(api.getConnections).mockResolvedValue([]);
    vi.mocked(api.getConnectionVisibilityOptions).mockResolvedValue(mockVisibilityOptions);
  });

  const renderSettings = () =>
    render(
      <SambeeThemeProvider>
        <ConnectionSettings isAdmin={false} />
      </SambeeThemeProvider>
    );

  it("shows a loading state instead of flashing the empty state before connections load", async () => {
    vi.mocked(api.getConnections).mockReturnValue(new Promise(() => undefined));

    await act(async () => {
      renderSettings();
    });

    expect(screen.queryByText(/no connections configured/i)).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows Add connection immediately when administrator access is already known", () => {
    vi.mocked(api.getCurrentUser).mockReturnValue(new Promise(() => undefined));
    vi.mocked(api.getConnections).mockReturnValue(new Promise(() => undefined));

    render(
      <SambeeThemeProvider>
        <ConnectionSettings isAdmin />
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("button", { name: /add connection/i })).toBeInTheDocument();
    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("keeps Add connection in the footer when the parent renders the page header", async () => {
    vi.mocked(api.getConnections).mockReturnValue(new Promise(() => undefined));

    render(
      <SambeeThemeProvider>
        <ConnectionSettings isAdmin showHeader={false} />
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("button", { name: /add connection/i })).toBeInTheDocument();
    await waitFor(() => expect(api.getCurrentUser).toHaveBeenCalled());
  });

  it("shows backend-defined visibility options when the dialog opens", async () => {
    const user = userEvent.setup();

    renderSettings();

    await waitFor(() => {
      expect(api.getCurrentUser).toHaveBeenCalled();
      expect(api.getConnections).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: /add connection/i }));

    expect(await screen.findByText("A name to identify this connection in Sambee")).toBeInTheDocument();
    expect(screen.getByText("Password for the SMB account")).toBeInTheDocument();

    const visibilitySelect = await screen.findByRole("combobox", { name: /visibility/i });
    expect(visibilitySelect).toBeInTheDocument();

    await user.click(visibilitySelect);

    expect(await screen.findByRole("option", { name: /private to me/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /shared with everyone/i })).toBeInTheDocument();
    expect(api.getConnectionVisibilityOptions).toHaveBeenCalled();
  });

  it("does not render an empty padded header block in headerless mobile mode", async () => {
    mockMobileMode(true);
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "shared-1",
        name: "Accounting",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "accounting",
        username: "sambee",
        path_prefix: "/",
        scope: "shared",
        access_mode: "read_write",
        can_manage: false,
      }),
    ]);

    render(
      <SambeeThemeProvider>
        <ConnectionSettings isAdmin={false} showHeader={false} />
      </SambeeThemeProvider>
    );

    await screen.findByText("Shared connections");

    expect(screen.queryByTestId("connection-settings-inline-header")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shared connections", level: 2 })).toBeInTheDocument();
    expect(screen.getByTestId("connection-settings-shared-section")).toHaveStyle({ marginTop: "0px" });
    expect(screen.getByTestId("connection-settings-private-section")).toHaveStyle({ marginTop: "32px" });
  });

  it("does not render an empty header or add top margin in headerless desktop mode", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "shared-1",
        name: "Accounting",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "accounting",
        username: "sambee",
        path_prefix: "/",
        scope: "shared",
        access_mode: "read_write",
        can_manage: true,
      }),
    ]);

    render(
      <SambeeThemeProvider>
        <ConnectionSettings isAdmin={true} showHeader={false} />
      </SambeeThemeProvider>
    );

    await screen.findByText("Shared connections");

    expect(screen.queryByTestId("connection-settings-inline-header")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shared connections", level: 2 })).toBeInTheDocument();
    expect(screen.getByTestId("connection-settings-shared-section")).toHaveStyle({ marginTop: "0px" });
    expect(screen.getByTestId("connection-settings-private-section")).toHaveStyle({ marginTop: "32px" });
  });

  it("uses bold body text for connection names and aligns each group's first row with its section", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "shared-1",
        name: "Accounting",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "accounting",
        username: "sambee",
        path_prefix: "/",
        scope: "shared",
        access_mode: "read_write",
        can_manage: true,
      }),
    ]);

    renderSettings();

    const connectionName = await screen.findByText("Accounting");

    expect(screen.queryByRole("heading", { name: "Accounting" })).not.toBeInTheDocument();
    expect(connectionName.tagName).toBe("DIV");
    expect(connectionName).toHaveClass("MuiTypography-body1");
    expect(window.getComputedStyle(connectionName).fontWeight).toBe("600");
    expect(connectionName.closest("li")).toHaveStyle({ paddingTop: "0px" });
  });

  it("shows a read-only badge for read-only connections", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "shared-1",
        name: "Accounting",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "accounting",
        username: "sambee",
        path_prefix: "/",
        scope: "shared",
        access_mode: "read_only",
        can_manage: true,
      }),
    ]);

    renderSettings();

    await screen.findByText("Accounting");

    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("does not show a read-only badge for default read and write connections", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "shared-1",
        name: "Accounting",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "accounting",
        username: "sambee",
        path_prefix: "/",
        scope: "shared",
        access_mode: "read_write",
        can_manage: true,
      }),
    ]);

    renderSettings();

    await screen.findByText("Accounting");

    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
  });

  it("shows read-only state without management actions when backend returns effective viewer access", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({
      id: "viewer-id",
      username: "viewer",
      role: "viewer",
    });
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "private-1",
        name: "Viewer Private Share",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "viewer-private",
        username: "viewer-user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_only",
        can_manage: false,
      }),
    ]);

    renderSettings();

    await screen.findByText("Viewer Private Share");

    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test connection/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit connection/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete connection/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add connection/i })).not.toBeInTheDocument();
  });

  it("does not show the mobile add connection fab for viewer users", async () => {
    mockMobileMode(true);
    vi.mocked(api.getCurrentUser).mockResolvedValue({
      id: "viewer-id",
      username: "viewer",
      role: "viewer",
    });
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "private-1",
        name: "Viewer Private Share",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "viewer-private",
        username: "viewer-user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_only",
        can_manage: false,
      }),
    ]);

    renderSettings();

    await screen.findByText("Viewer Private Share");

    expect(screen.queryByLabelText(/add connection/i)).not.toBeInTheDocument();
  });

  it("omits Test Connection from the small-screen connection actions menu", async () => {
    mockMobileMode(true);
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "private-1",
        name: "Managed Private Share",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "managed-private",
        username: "managed-user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
      }),
    ]);

    const user = userEvent.setup();
    renderSettings();

    await screen.findByText("Managed Private Share");
    await user.click(screen.getByRole("button", { name: /connection actions/i }));

    expect(screen.queryByRole("menuitem", { name: /test connection/i })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^delete$/i })).toBeInTheDocument();
  });

  it("omits Test Connection from managed desktop actions", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([
      createMockConnection({
        id: "private-1",
        name: "Managed Private Share",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "managed-private",
        username: "managed-user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
      }),
    ]);

    renderSettings();

    await screen.findByText("Managed Private Share");

    expect(screen.queryByRole("button", { name: /test connection/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit connection/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete connection/i })).toBeInTheDocument();
  });

  it("shows a viewer-specific empty state when the user cannot create connections", async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue({
      id: "viewer-id",
      username: "viewer",
      role: "viewer",
    });
    vi.mocked(api.getConnections).mockResolvedValue([]);

    renderSettings();

    expect(await screen.findByText("No connections configured")).toBeInTheDocument();
    expect(
      screen.getByText("No connections are available for your account yet. Contact an administrator to create or share one.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add connection/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/create your first private smb connection/i)).not.toBeInTheDocument();
  });

  it("persists updated visibility when editing and reopening a connection", async () => {
    const user = userEvent.setup();
    let connections = [
      createMockConnection({
        id: "shared-1",
        name: "Accounting",
        type: "smb",
        host: "fileserver.local",
        port: 445,
        share_name: "accounting",
        username: "sambee",
        path_prefix: "/",
        scope: "shared" as const,
        access_mode: "read_write" as const,
        can_manage: true,
      }),
    ];

    vi.mocked(api.getConnections).mockImplementation(async () => connections);
    vi.mocked(api.updateConnection).mockImplementation(async (_connectionId, updates) => {
      connections = connections.map((connection) => ({
        ...connection,
        ...updates,
      }));

      return requireTestValue(connections[0]);
    });

    render(
      <SambeeThemeProvider>
        <ConnectionSettings isAdmin={true} />
      </SambeeThemeProvider>
    );

    await screen.findByText("Accounting");

    await user.click(screen.getByRole("button", { name: /edit connection/i }));
    await user.click(await screen.findByRole("combobox", { name: /visibility/i }));
    await user.click(await screen.findByRole("option", { name: /private to me/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith("shared-1", { scope: "private" });
    });

    await waitFor(() => {
      expect(within(screen.getByTestId("connection-settings-private-section")).getByText("Accounting")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /edit connection/i }));

    expect(await screen.findByRole("combobox", { name: /visibility/i })).toHaveTextContent("Private to me");
  });
});
