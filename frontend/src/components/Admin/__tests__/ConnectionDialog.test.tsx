import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockConnection } from "../../../test/fixtures/connections";
import { uninitializedTestCallback } from "../../../test/helpers/assertions";
import type { Connection } from "../../../types";
import ConnectionDialog from "../ConnectionDialog";

// Mock the API module
vi.mock("../../../services/api", () => ({
  default: {
    getCurrentUser: vi.fn(),
    getConnectionVisibilityOptions: vi.fn(),
    createConnection: vi.fn(),
    updateConnection: vi.fn(),
    testConnection: vi.fn(),
    testConnectionConfig: vi.fn(),
    deleteConnection: vi.fn(),
  },
}));

import api from "../../../services/api";

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

const mockConnection: Connection = createMockConnection({
  id: "1",
  name: "Test Server",
  type: "smb",
  host: "192.168.1.100",
  port: 445,
  share_name: "share1",
  username: "testuser",
  path_prefix: "/",
  scope: "shared",
  access_mode: "read_write",
  can_manage: true,
  created_at: "2024-01-01T00:00:00",
  updated_at: "2024-01-01T00:00:00",
});

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

describe("ConnectionDialog Component", () => {
  const mockOnClose = vi.fn();
  const mockOnSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCurrentUser).mockResolvedValue({
      id: "user-id",
      username: "testuser",
      role: "editor",
    });
    vi.mocked(api.getConnectionVisibilityOptions).mockResolvedValue(mockVisibilityOptions);
  });

  it("uses consistent field descriptions in add and edit modes", async () => {
    const addDialog = render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);
    await waitFor(() => expect(api.getConnectionVisibilityOptions).toHaveBeenCalled());
    const addDescriptions = [
      "A name to identify this connection in Sambee",
      "IP address or hostname of the SMB server",
      "Name of the share on the server",
      "Use DOMAIN\\USER format if needed",
      "Password for the SMB account",
      "Base path within the share (optional)",
      "Choose private or shared access",
      "Choose read-only or read-write access",
    ];

    for (const description of addDescriptions) {
      expect(screen.getByText(description)).toHaveClass("MuiFormHelperText-root");
    }

    addDialog.unmount();
    await act(async () => {
      render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} connection={mockConnection} />);
    });

    expect(screen.getByText("Leave blank to keep existing password")).toHaveClass("MuiFormHelperText-root");
  });

  it("renders form fields for new connection", async () => {
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);
    await waitFor(() => expect(api.getConnectionVisibilityOptions).toHaveBeenCalled());

    expect(screen.getByRole("heading", { name: /add connection/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/connection name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/host/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/share name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/user name/i)).toBeInTheDocument();
    // Password field - use getAllByLabelText and filter to get the input
    const passwordFields = screen.getAllByLabelText(/password/i);
    const passwordInput = passwordFields.find((el) => el.tagName === "INPUT");
    expect(passwordInput).toBeInTheDocument();
    expect(screen.getByLabelText(/path prefix/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /access mode/i })).toBeInTheDocument();
  });

  it("uses the shared one-column form design in a small-width dialog", async () => {
    const restoreViewport = mockViewportWidth(800);

    try {
      render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

      await waitFor(() => expect(api.getConnectionVisibilityOptions).toHaveBeenCalled());
      const nameLabel = screen.getByText("Connection name", { selector: "label" });
      const nameInput = screen.getByLabelText(/connection name/i);

      expect(screen.queryByTestId("responsive-form-dialog-mobile-actions")).not.toBeInTheDocument();
      expect(document.querySelector(".MuiDialog-paperWidthSm")).not.toBeNull();
      expect(nameLabel).toHaveClass("MuiInputLabel-root");
      expect(nameInput.parentElement).not.toHaveClass("MuiInputBase-sizeSmall");
      expect(screen.getByText("A name to identify this connection in Sambee")).toHaveClass("MuiFormHelperText-root");
      expect(screen.getByRole("heading", { name: "Access", level: 2 })).toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });

  it("keeps standard MUI floating labels and helper text in the mobile drawer", async () => {
    const restoreViewport = mockViewportWidth(390);

    try {
      const user = userEvent.setup();
      render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

      const nameLabel = screen.getByText("Connection name", { selector: "label" });
      const nameInput = screen.getByLabelText(/connection name/i);

      expect(screen.getByTestId("responsive-form-dialog-mobile-actions")).toBeInTheDocument();
      expect(nameLabel).toHaveClass("MuiInputLabel-root");
      expect(nameLabel).not.toHaveClass("MuiInputLabel-shrink");
      expect(nameInput.parentElement).not.toHaveClass("MuiInputBase-sizeSmall");
      expect(screen.getByText("A name to identify this connection in Sambee")).toHaveClass("MuiFormHelperText-root");
      expect(screen.getByRole("heading", { name: "Access", level: 2 })).toBeInTheDocument();

      await user.type(nameInput, "Server");

      expect(nameLabel).toHaveClass("MuiInputLabel-shrink");
    } finally {
      restoreViewport();
    }
  });

  it("uses external labels, compact outlined fields, and label-column errors at the md breakpoint", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      const user = userEvent.setup();
      render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByText("Connection name", { selector: "label" })).toHaveAttribute("for", "connection-name");
      const primaryFieldGroup = screen.getByTestId("connection-dialog-fields");
      expect(primaryFieldGroup).toBeInTheDocument();
      for (const inputId of [
        "connection-name",
        "connection-host",
        "connection-share-name",
        "connection-username",
        "connection-password",
        "connection-path-prefix",
      ]) {
        expect(primaryFieldGroup.querySelector(`#${inputId}`)).not.toBeNull();
      }
      expect(primaryFieldGroup.querySelector("#connection-scope")).toBeNull();
      expect(primaryFieldGroup.querySelector("#connection-access-mode")).toBeNull();
      const formSurface = screen.getByTestId("connection-dialog-form-surface");
      expect(formSurface).toContainElement(primaryFieldGroup);
      const accessHeading = screen.getByRole("heading", { name: "Access", level: 2 });
      expect(formSurface).toContainElement(accessHeading);
      expect(window.getComputedStyle(accessHeading.parentElement!).marginBottom).toBe("0px");
      expect(window.getComputedStyle(accessHeading.parentElement!.parentElement!).borderTopWidth).toBe("1px");
      expect(window.getComputedStyle(accessHeading.parentElement!.parentElement!).paddingTop).toBe("16px");
      expect(screen.getByLabelText(/connection name/i).parentElement).toHaveClass("MuiOutlinedInput-root");
      expect(screen.getByLabelText(/connection name/i).parentElement).toHaveClass("MuiInputBase-sizeSmall");
      expect(document.querySelector(".MuiDialog-paperWidthSm")).not.toBeNull();
      expect(screen.getByText("A name to identify this connection in Sambee")).not.toHaveClass("MuiFormHelperText-root");
      const visibilitySelect = screen.getByRole("combobox", { name: /visibility/i });
      expect(visibilitySelect.closest(".MuiFormControl-root")).not.toHaveClass("MuiFormControl-fullWidth");
      expect(visibilitySelect.parentElement).toHaveClass("MuiOutlinedInput-root");

      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => {
        const hostInput = screen.getByLabelText(/host/i);
        const hostError = screen.getByText("Host is required");

        expect(hostInput).toHaveAttribute("aria-describedby", "connection-host-description");
        expect(hostError).toHaveAttribute("id", "connection-host-description");
        expect(hostError).not.toHaveClass("MuiFormHelperText-root");
        expect(screen.getByLabelText(/connection name/i)).toHaveFocus();
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("shows server-defined visibility options", async () => {
    const user = userEvent.setup();

    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

    const visibilitySelect = await screen.findByRole("combobox", { name: /visibility/i });
    expect(visibilitySelect).toBeInTheDocument();

    await user.click(visibilitySelect);

    expect(await screen.findByRole("option", { name: /private to me/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /shared with everyone/i })).toBeInTheDocument();
    expect(api.getConnectionVisibilityOptions).toHaveBeenCalled();
  });

  it("renders form with existing connection data in edit mode", async () => {
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} connection={mockConnection} />);
    await waitFor(() => expect(api.getConnectionVisibilityOptions).toHaveBeenCalled());

    expect(screen.getByRole("heading", { name: /edit connection/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/connection name/i)).toHaveValue("Test Server");
    expect(screen.getByLabelText(/host/i)).toHaveValue("192.168.1.100");
    expect(screen.getByLabelText(/share name/i)).toHaveValue("share1");
    expect(screen.getByLabelText(/user name/i)).toHaveValue("testuser");
    // Password should be empty for security - use getAllByLabelText and filter
    const passwordFields = screen.getAllByLabelText(/password/i);
    const passwordInput = passwordFields.find((el) => el.tagName === "INPUT") as HTMLInputElement;
    expect(passwordInput).toHaveValue("");
    expect(screen.getByLabelText(/path prefix/i)).toHaveValue("/");
    expect(screen.getByRole("combobox", { name: /access mode/i })).toHaveTextContent(/read and write/i);
  });

  it("validates required fields", async () => {
    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

    // Try to save without filling any fields
    const saveButton = screen.getByRole("button", { name: /^save$/i });
    await user.click(saveButton);

    // Should show validation errors
    await waitFor(() => {
      expect(screen.getByText(/connection name is required/i)).toBeInTheDocument();
      expect(screen.getByText(/host is required/i)).toBeInTheDocument();
      expect(screen.getByText(/share name is required/i)).toBeInTheDocument();
      expect(screen.getByText(/username is required/i)).toBeInTheDocument();
      expect(screen.getByText(/password is required/i)).toBeInTheDocument();
    });

    // Should not call API
    expect(api.createConnection).not.toHaveBeenCalled();
  });

  it("creates new connection with valid data", async () => {
    vi.mocked(api.createConnection).mockResolvedValueOnce(mockConnection);

    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

    // Fill in form - using paste() is faster than type() for known values
    await user.click(screen.getByLabelText(/connection name/i));
    await user.paste("New Server");

    await user.click(screen.getByLabelText(/host/i));
    await user.paste("192.168.1.200");

    await user.click(screen.getByLabelText(/share name/i));
    await user.paste("newshare");

    await user.click(screen.getByLabelText(/user name/i));
    await user.paste("newuser");

    // Get password input using getAllByLabelText
    const passwordFields = screen.getAllByLabelText(/password/i);
    const passwordInput = passwordFields.find((el) => el.tagName === "INPUT") as HTMLElement;
    await user.click(passwordInput);
    await user.paste("newpass");

    // Save
    const saveButton = screen.getByRole("button", { name: /^save$/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith({
        name: "New Server",
        type: "smb",
        host: "192.168.1.200",
        port: 445,
        share_name: "newshare",
        username: "newuser",
        password: "newpass",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
      });
    });

    expect(mockOnSave).toHaveBeenCalled();
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("updates existing connection", async () => {
    vi.mocked(api.updateConnection).mockResolvedValueOnce(mockConnection);

    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} connection={mockConnection} />);

    // Change the name - using paste() is faster than type()
    const nameField = screen.getByLabelText(/connection name/i);
    await user.clear(nameField);
    await user.paste("Updated Server");

    // Save
    const saveButton = screen.getByRole("button", { name: /^save$/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith("1", {
        name: "Updated Server",
      });
    });

    expect(mockOnSave).toHaveBeenCalled();
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("updates access mode when changed", async () => {
    vi.mocked(api.updateConnection).mockResolvedValueOnce({
      ...mockConnection,
      access_mode: "read_only",
    });

    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} connection={mockConnection} />);

    await user.click(screen.getByRole("combobox", { name: /access mode/i }));
    await user.click(await screen.findByRole("option", { name: /read only/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith("1", {
        access_mode: "read_only",
      });
    });
  });

  it("updates visibility when changed", async () => {
    vi.mocked(api.updateConnection).mockResolvedValueOnce({
      ...mockConnection,
      scope: "private",
    });

    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} connection={mockConnection} />);

    await user.click(screen.getByRole("combobox", { name: /visibility/i }));
    await user.click(await screen.findByRole("option", { name: /private to me/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith("1", {
        scope: "private",
      });
    });
  });

  it("shows error message on save failure", async () => {
    vi.mocked(api.createConnection).mockRejectedValueOnce({
      response: { data: { detail: "Connection failed: Invalid credentials" } },
    });

    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

    // Fill in form - using paste() is faster than type()
    await user.click(screen.getByLabelText(/connection name/i));
    await user.paste("New Server");

    await user.click(screen.getByLabelText(/host/i));
    await user.paste("192.168.1.200");

    await user.click(screen.getByLabelText(/share name/i));
    await user.paste("share");

    await user.click(screen.getByLabelText(/user name/i));
    await user.paste("user");

    // Get password input using getAllByLabelText
    const passwordFields = screen.getAllByLabelText(/password/i);
    const passwordInput = passwordFields.find((el) => el.tagName === "INPUT") as HTMLElement;
    await user.click(passwordInput);
    await user.paste("wrongpass");

    // Save
    const saveButton = screen.getByRole("button", { name: /^save$/i });
    await user.click(saveButton);

    // Should show error
    await waitFor(() => {
      expect(screen.getByText(/connection failed: invalid credentials/i)).toBeInTheDocument();
    });

    // Should not call onSave or onClose
    expect(mockOnSave).not.toHaveBeenCalled();
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("keeps the save label visible while the save request is pending", async () => {
    let resolveCreate: (value: Connection) => void = uninitializedTestCallback;
    vi.mocked(api.createConnection).mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );

    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

    await user.click(screen.getByLabelText(/connection name/i));
    await user.paste("New Server");

    await user.click(screen.getByLabelText(/host/i));
    await user.paste("192.168.1.200");

    await user.click(screen.getByLabelText(/share name/i));
    await user.paste("newshare");

    await user.click(screen.getByLabelText(/user name/i));
    await user.paste("newuser");

    const passwordFields = screen.getAllByLabelText(/password/i);
    const passwordInput = passwordFields.find((el) => el.tagName === "INPUT") as HTMLElement;
    await user.click(passwordInput);
    await user.paste("newpass");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(api.createConnection).toHaveBeenCalled();
    });

    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^save$/i })).toHaveTextContent(/^save$/i);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    await act(async () => {
      resolveCreate(mockConnection);
    });
  });

  it("closes dialog on cancel", async () => {
    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalled();
    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it("tests connection successfully", async () => {
    const restoreViewport = mockViewportWidth(1000);
    vi.mocked(api.testConnection).mockResolvedValueOnce({
      status: "success",
      message: "Connection test successful",
    });

    try {
      const user = userEvent.setup();
      render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} connection={mockConnection} />);

      // Click test connection button
      const testButton = screen.getByRole("button", { name: /test connection/i });
      await user.click(testButton);

      await waitFor(() => {
        expect(api.testConnection).toHaveBeenCalledWith("1", {
          host: "192.168.1.100",
          port: 445,
          share_name: "share1",
          username: "testuser",
          path_prefix: "/",
        });
        expect(screen.getByText("Connection successful")).toBeInTheDocument();
        expect(screen.queryByRole("dialog", { name: "Connection test failed" })).not.toBeInTheDocument();
      });
    } finally {
      restoreViewport();
    }
  });

  it("shows an acknowledged error dialog when a connection test fails", async () => {
    const restoreViewport = mockViewportWidth(1000);
    vi.mocked(api.testConnection).mockResolvedValueOnce({
      status: "error",
      message: "Authentication failed for testuser",
    });

    try {
      const user = userEvent.setup();
      render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} connection={mockConnection} />);

      await user.click(screen.getByRole("button", { name: /test connection/i }));

      const resultDialog = await screen.findByRole("dialog", { name: "Connection test failed" });
      expect(resultDialog).toHaveTextContent("Authentication failed for testuser");
      await user.keyboard("{Escape}");

      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Connection test failed" })).not.toBeInTheDocument();
        expect(screen.getByText("Connection failed")).toBeInTheDocument();
      });
    } finally {
      restoreViewport();
    }
  });

  it("shows only the test outcome icon inside the button below the md breakpoint", async () => {
    const restoreViewport = mockViewportWidth(800);
    vi.mocked(api.testConnection).mockResolvedValueOnce({
      status: "success",
      message: "Connection test successful",
    });

    try {
      const user = userEvent.setup();
      render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} connection={mockConnection} />);

      const testButton = screen.getByRole("button", { name: /test connection/i });
      await user.click(testButton);

      await waitFor(() => {
        expect(testButton.querySelector("svg[data-testid='CheckCircleOutlinedIcon']")).not.toBeNull();
        expect(screen.queryByText("Connection successful")).not.toBeInTheDocument();
      });
    } finally {
      restoreViewport();
    }
  });

  it("toggles password visibility", async () => {
    const user = userEvent.setup();
    render(<ConnectionDialog open={true} onClose={mockOnClose} onSave={mockOnSave} />);

    // Get password input using getAllByLabelText
    const passwordFields = screen.getAllByLabelText(/password/i);
    const passwordInput = passwordFields.find((el) => el.tagName === "INPUT") as HTMLInputElement;
    expect(passwordInput).toHaveAttribute("type", "password");

    // Click visibility toggle
    const toggleButton = screen.getByRole("button", {
      name: /toggle password visibility/i,
    });
    await user.click(toggleButton);

    // Password should now be visible
    expect(passwordInput).toHaveAttribute("type", "text");

    // Click again to hide
    await user.click(toggleButton);
    expect(passwordInput).toHaveAttribute("type", "password");
  });
});
