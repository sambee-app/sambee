import { Button } from "@mui/material";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "../../../hooks/useKeyboardShortcuts";
import { SambeeThemeProvider } from "../../../theme";
import { ResponsiveDialogShell } from "../../Dialog/ResponsiveDialogShell";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

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

describe("ResponsiveFormDialog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mockMobileMode(false);
  });

  it.each([false, true])("isolates dialog shortcuts from the parent workspace (mobile: %s)", async (isMobile) => {
    mockMobileMode(isMobile);
    const backgroundShortcut = vi.fn();
    const unavailableShortcut = vi.fn(() => true);
    const dialogShortcut = vi.fn();
    const backgroundKeyDown = vi.fn();
    const onClose = vi.fn();
    function DialogContent() {
      useKeyboardShortcuts({
        shortcuts: [{ id: "select", keys: "a", ctrl: true, description: "Select report", handler: dialogShortcut }],
      });
      return (
        <>
          <div tabIndex={-1} data-testid="report">
            Report
          </div>
          {createPortal(<div data-testid="portaled-control">Portaled control</div>, document.body)}
        </>
      );
    }
    function Workspace({ open }: { open: boolean }) {
      useKeyboardShortcuts({
        shortcuts: [
          { id: "select", keys: "a", ctrl: true, description: "Select files", handler: backgroundShortcut },
          { id: "delete", keys: "Delete", description: "Delete files", handler: backgroundShortcut },
          {
            id: "save",
            keys: "s",
            ctrl: true,
            description: "Save",
            handler: backgroundShortcut,
            enabled: false,
            onUnavailable: unavailableShortcut,
          },
        ],
      });
      return (
        <div role="application" onKeyDown={backgroundKeyDown} tabIndex={-1} data-testid="workspace">
          <ResponsiveDialogShell open={open} onClose={onClose} title="Report">
            <DialogContent />
          </ResponsiveDialogShell>
        </div>
      );
    }
    const { rerender } = render(<Workspace open />);
    const report = screen.getByTestId("report");
    report.focus();
    fireEvent.keyDown(report, { key: "a", ctrlKey: true });
    expect(dialogShortcut).toHaveBeenCalledOnce();
    expect(backgroundShortcut).not.toHaveBeenCalled();
    expect(backgroundKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("portaled-control"), { key: "a", ctrlKey: true });
    expect(dialogShortcut).toHaveBeenCalledTimes(2);
    expect(backgroundShortcut).not.toHaveBeenCalled();
    expect(backgroundKeyDown).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(report, { key: "Delete" })).toBe(true);
    expect(fireEvent.keyDown(report, { key: "s", ctrlKey: true })).toBe(true);
    expect(backgroundShortcut).not.toHaveBeenCalled();
    expect(unavailableShortcut).not.toHaveBeenCalled();
    expect(backgroundKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(report, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(backgroundKeyDown).not.toHaveBeenCalled();
    rerender(<Workspace open={false} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    screen.getByTestId("workspace").focus();
    fireEvent.keyDown(screen.getByTestId("workspace"), { key: "a", ctrlKey: true });
    expect(backgroundShortcut).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps nested dialog shortcuts and Escape in the innermost scope (mobile: %s)", (isMobile) => {
    mockMobileMode(isMobile);
    const parentShortcut = vi.fn();
    const childShortcut = vi.fn();
    const parentClose = vi.fn();
    const childClose = vi.fn();
    function ShortcutContent({ handler }: { handler: () => void }) {
      useKeyboardShortcuts({ shortcuts: [{ id: "select", keys: "a", ctrl: true, description: "Select", handler }] });
      return null;
    }
    render(
      <ResponsiveDialogShell open onClose={parentClose} title="Parent">
        <ShortcutContent handler={parentShortcut} />
        <ResponsiveDialogShell open onClose={childClose} title="Child">
          <ShortcutContent handler={childShortcut} />
          <div tabIndex={-1} data-testid="child-report">
            Report
          </div>
        </ResponsiveDialogShell>
      </ResponsiveDialogShell>
    );
    const report = screen.getByTestId("child-report");
    report.focus();
    fireEvent.keyDown(report, { key: "a", ctrlKey: true });
    expect(childShortcut).toHaveBeenCalledOnce();
    expect(parentShortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(report, { key: "Escape" });
    expect(childClose).toHaveBeenCalledOnce();
    expect(parentClose).not.toHaveBeenCalled();
  });

  it("renders the shared description above the dialog body on desktop", () => {
    render(
      <SambeeThemeProvider>
        <ResponsiveDialogShell
          open={true}
          onClose={vi.fn()}
          title="Edit User"
          description="Update the account details below."
          actions={<Button>Save</Button>}
        >
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("heading", { name: /edit user/i })).toBeInTheDocument();
    expect(screen.getByText("Update the account details below.")).toBeInTheDocument();
    expect(screen.getByText("Dialog Body")).toBeInTheDocument();
    expect(window.getComputedStyle(screen.getByText("Dialog Body").closest(".MuiDialogContent-root") as HTMLElement).paddingLeft).toBe(
      "24px"
    );
    expect(window.getComputedStyle(screen.getByTestId("responsive-form-dialog-desktop-actions")).borderTopWidth).toBe("1px");
  });

  it("renders the shared description in the mobile sheet body", () => {
    mockMobileMode(true);

    render(
      <SambeeThemeProvider>
        <ResponsiveDialogShell
          open={true}
          onClose={vi.fn()}
          title="Edit User"
          description="Update the account details below."
          actions={<Button>Save</Button>}
        >
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("button", { name: /common\.navigation\.goBack/i })).toBeInTheDocument();
    expect(screen.getByText("Update the account details below.")).toBeInTheDocument();
    expect(screen.getByText("Dialog Body")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Edit User" })).toHaveStyle({ fontSize: "20px" });
    expect(screen.getByText("Dialog Body")).toHaveStyle({ fontSize: "17px" });
    const actions = screen.getByTestId("responsive-form-dialog-mobile-actions");
    const drawerPaper = actions.closest(".MuiDrawer-paper");

    expect(actions).toHaveStyle({
      position: "sticky",
      bottom: "0px",
    });
    const drawerStyles = window.getComputedStyle(drawerPaper as HTMLElement);

    expect(drawerStyles.getPropertyValue("--sambee-overlay-surface")).not.toBe("");
    expect(drawerStyles.getPropertyValue("--sambee-form-surface")).not.toBe("");
    expect(drawerStyles.getPropertyValue("--sambee-form-surface")).not.toBe(drawerStyles.getPropertyValue("--sambee-overlay-surface"));
  });

  it("restores focus to the triggering element after the dialog closes", async () => {
    const { rerender } = render(
      <SambeeThemeProvider>
        <button type="button">Open Dialog</button>
        <ResponsiveDialogShell open={false} onClose={vi.fn()} title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    const triggerButton = screen.getByRole("button", { name: /open dialog/i });
    triggerButton.focus();

    rerender(
      <SambeeThemeProvider>
        <button type="button">Open Dialog</button>
        <ResponsiveDialogShell open={true} onClose={vi.fn()} title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    rerender(
      <SambeeThemeProvider>
        <button type="button">Open Dialog</button>
        <ResponsiveDialogShell open={false} onClose={vi.fn()} title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(triggerButton).toHaveFocus();
    });
  });

  it("does not restore focus when restoration is disabled", async () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <SambeeThemeProvider>
        <button type="button">Open Dialog</button>
        <button type="button">Fallback Focus</button>
        <ResponsiveDialogShell open={false} onClose={vi.fn()} disableRestoreFocus title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    const triggerButton = screen.getByRole("button", { name: /open dialog/i });
    const fallbackButton = screen.getByRole("button", { name: /fallback focus/i });
    triggerButton.focus();

    rerender(
      <SambeeThemeProvider>
        <button type="button">Open Dialog</button>
        <button type="button">Fallback Focus</button>
        <ResponsiveDialogShell open={true} onClose={vi.fn()} disableRestoreFocus title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    rerender(
      <SambeeThemeProvider>
        <button type="button">Open Dialog</button>
        <button type="button">Fallback Focus</button>
        <ResponsiveDialogShell open={false} onClose={vi.fn()} disableRestoreFocus title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    fallbackButton.focus();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(fallbackButton).toHaveFocus();
  });

  it("disables the mobile back affordance when close is disabled", () => {
    mockMobileMode(true);

    render(
      <SambeeThemeProvider>
        <ResponsiveDialogShell open={true} onClose={vi.fn()} disableClose title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("button", { name: /common\.navigation\.goBack/i })).toBeDisabled();
  });

  it("ignores Escape when close is disabled on desktop", () => {
    const onClose = vi.fn();
    render(
      <SambeeThemeProvider>
        <ResponsiveDialogShell open={true} onClose={onClose} disableClose title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape when close is disabled on mobile", () => {
    mockMobileMode(true);
    const onClose = vi.fn();
    render(
      <SambeeThemeProvider>
        <ResponsiveDialogShell open={true} onClose={onClose} disableClose title="Edit User" actions={<Button>Save</Button>}>
          <div>Dialog Body</div>
        </ResponsiveDialogShell>
      </SambeeThemeProvider>
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });
});
