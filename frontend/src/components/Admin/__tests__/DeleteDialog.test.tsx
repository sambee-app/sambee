import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SambeeThemeProvider } from "../../../theme";
import DeleteDialog from "../DeleteDialog";

vi.mock("react-i18next", async () => (await import("../../../test/mocks/reactI18next")).mockReactI18next());

function mockMobileMode(isMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isMobile,
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

describe("DeleteDialog", () => {
  beforeEach(() => {
    mockMobileMode(false);
  });

  it("renders as a mobile-style sheet on small screens", () => {
    mockMobileMode(true);

    render(
      <SambeeThemeProvider>
        <DeleteDialog
          open={true}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
          title="Delete Connection"
          description="Are you sure?"
          descriptionItemName="Docs"
        />
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("button", { name: /common\.navigation\.goBack/i })).toBeInTheDocument();
    expect(screen.getByText("Delete Connection")).toBeInTheDocument();
    expect(screen.getByText("Docs", { exact: true }).tagName).toBe("STRONG");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("disables both actions and shows progress while submitting", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    render(
      <SambeeThemeProvider>
        <DeleteDialog
          open={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="Delete Connection"
          description="Are you sure?"
          submitting
        />
      </SambeeThemeProvider>
    );

    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    const confirmButton = screen.getByRole("button", { name: /delete/i });

    expect(cancelButton).toBeDisabled();
    expect(confirmButton).toBeDisabled();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses the shared inline item-name confirmation, responsive action layout, and safe initial focus", async () => {
    const { rerender } = render(
      <SambeeThemeProvider>
        <DeleteDialog
          open={false}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
          title="Delete Connection"
          description="Are you sure?"
          descriptionItemName="Docs"
        />
      </SambeeThemeProvider>
    );

    rerender(
      <SambeeThemeProvider>
        <DeleteDialog
          open
          onClose={vi.fn()}
          onConfirm={vi.fn()}
          title="Delete Connection"
          description="Are you sure?"
          descriptionItemName="Docs"
        />
      </SambeeThemeProvider>
    );

    expect(screen.getByText("Docs", { exact: true }).tagName).toBe("STRONG");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("DeleteIcon").closest("button")).toHaveTextContent("common.actions.delete");
    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    expect(screen.getByTestId("responsive-form-dialog-desktop-actions")).toContainElement(cancelButton);
    await waitFor(() => expect(cancelButton).toHaveFocus());
  });

  it("puts a connection name in bold inside its deletion question instead of rendering a field", () => {
    render(
      <SambeeThemeProvider>
        <DeleteDialog
          open
          onClose={vi.fn()}
          onConfirm={vi.fn()}
          title="Delete Connection"
          description="Are you sure you want to delete the connection?"
          descriptionItemName="Demo Share"
        />
      </SambeeThemeProvider>
    );

    const connectionName = screen.getByText("Demo Share", { exact: true });
    expect(connectionName.tagName).toBe("STRONG");
    expect(connectionName.parentElement).toHaveTextContent("Are you sure you want to delete the connection Demo Share?");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
